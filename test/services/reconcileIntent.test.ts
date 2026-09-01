import { randomUUID } from "node:crypto";
import * as broadcast from "src/chain/broadcast.js";
import { listAuditEventsForIntent } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import * as intentsDb from "src/db/intents.js";
import {
  claimIntentForExecution,
  createIntent,
  getIntent,
  getIntentSignedRawTx,
  persistBroadcastSignature,
  transitionBroadcastIntent,
} from "src/db/intents.js";
import { createWallet } from "src/db/wallets.js";
import { ApiErrorCode, Asset, AuditEventType, IntentStatus } from "src/domain/types.js";
import { acquireExecution, resetExecutionLock } from "src/services/executionLock.js";
import { reconcileIntent } from "src/services/reconcileIntent.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex } from "src/signers/types.js";
import { AppError } from "src/utils/errors.js";
import { addressFromNumber } from "test/helpers/json.js";
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = openDb(`./data/test-reconcile-${Date.now()}.db`);
const signer = new LocalKeySigner(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const from = await signer.getAddress();
const to = addressFromNumber(200);
const value = 10n ** 15n;
const signedRawTx = await signer.signTransaction({
  to,
  value,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  chainId: 31337,
});
const txHash = keccak256(signedRawTx);

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutionLock();
});

function seedBroadcast(opts: { txHash?: Hex; signedRawTx?: Hex } = {}) {
  const wallet = createWallet(db, {
    id: randomUUID(),
    address: from,
    createdAt: new Date().toISOString(),
  });
  const created = createIntent(db, {
    id: randomUUID(),
    fromWalletId: wallet.id,
    to,
    value,
    asset: Asset.Eth,
    initiatorId: "dev-initiator",
    status: IntentStatus.Approved,
    createdAt: new Date().toISOString(),
  });
  expect(claimIntentForExecution(db, created.id)).toBe(true);
  if (opts.txHash !== undefined) {
    expect(
      persistBroadcastSignature(db, created.id, opts.txHash, opts.signedRawTx ?? signedRawTx),
    ).toBe(true);
  }
  const intent = getIntent(db, created.id);
  if (!intent) throw new Error("seed failed");
  return intent;
}

function matchingTx() {
  return { to, from, value, hash: txHash, input: "0x" };
}

describe("reconcileIntent", () => {
  it("throws NotFound when the intent is missing", async () => {
    await expect(reconcileIntent(db, randomUUID(), "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("throws InvalidStatus when the intent is not Broadcast", async () => {
    const intent = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to,
      value,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    });
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
  });

  it("returns the stored row when already Confirmed", async () => {
    const intent = seedBroadcast({ txHash });
    expect(transitionBroadcastIntent(db, intent.id, IntentStatus.Confirmed, txHash)).toBe(true);
    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
  });

  it("unclaims back to Approved when nothing was signed", async () => {
    const intent = seedBroadcast();
    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Approved);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ExecutionAborted,
      ),
    ).toBe(true);
  });

  it("refuses while execute is in-flight", async () => {
    const intent = seedBroadcast({ txHash });
    acquireExecution(intent.id);
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ExecutionInProgress,
    });
  });

  it("confirms from a matching receipt", async () => {
    const intent = seedBroadcast({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
  });

  it("marks Failed when the receipt reverted", async () => {
    const intent = seedBroadcast({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "reverted",
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxReverted,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });

  it("throws TxPending when the tx is not on chain and there is no raw to rebroadcast", async () => {
    const intent = seedBroadcast({ txHash, signedRawTx });
    db.prepare(`UPDATE intents SET signed_raw_tx = NULL WHERE id = ?`).run(intent.id);
    vi.spyOn(broadcast, "getTx").mockRejectedValue(new TransactionNotFoundError({ hash: txHash }));

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("throws TxPending when the receipt is not yet mined", async () => {
    const intent = seedBroadcast({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
  });

  it("fails closed when the chain tx does not match the intent", async () => {
    const intent = seedBroadcast({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      ...matchingTx(),
      to: addressFromNumber(201),
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(getIntentSignedRawTx(db, intent.id)).toBe(signedRawTx);
    const second = createIntent(db, {
      id: randomUUID(),
      fromWalletId: intent.fromWalletId,
      to,
      value,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    expect(() => claimIntentForExecution(db, second.id)).toThrow();
  });

  it("rebroadcasts the stored raw tx when the hash is not yet on chain, then confirms", async () => {
    const intent = seedBroadcast({ txHash, signedRawTx });
    const send = vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(send).toHaveBeenCalledWith(signedRawTx);
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
  });

  it("fails closed when the stored raw tx does not hash to the stored tx hash", async () => {
    const intent = seedBroadcast({ txHash, signedRawTx: "0xbeef" as Hex });
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(getIntentSignedRawTx(db, intent.id)).toBe("0xbeef");
  });

  it("throws NotFound when the from-wallet is missing", async () => {
    const intent = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to,
      value,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    expect(claimIntentForExecution(db, intent.id)).toBe(true);
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("returns the row when status changed while waiting for the lock", async () => {
    for (const status of [IntentStatus.Confirmed, IntentStatus.Failed, IntentStatus.Approved]) {
      const intent = seedBroadcast({ txHash });
      vi.spyOn(intentsDb, "getIntent")
        .mockReturnValueOnce(intent)
        .mockReturnValueOnce({ ...intent, status });
      const result = await reconcileIntent(db, intent.id, "dev-admin");
      expect(result.intent.status).toBe(status);
      vi.restoreAllMocks();
    }

    const pending = seedBroadcast({ txHash });
    vi.spyOn(intentsDb, "getIntent")
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce({ ...pending, status: IntentStatus.Pending });
    await expect(reconcileIntent(db, pending.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
  });

  it("throws TxPending when rebroadcast cannot land the tx", async () => {
    const sendFail = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("dropped"));
    vi.spyOn(broadcast, "getTx").mockRejectedValue(new TransactionNotFoundError({ hash: txHash }));
    await expect(reconcileIntent(db, sendFail.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });

    vi.restoreAllMocks();
    const stillMissing = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "getTx").mockRejectedValue(new TransactionNotFoundError({ hash: txHash }));
    await expect(reconcileIntent(db, stillMissing.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
  });

  it("confirms when rebroadcast send fails but the tx then appears", async () => {
    const intent = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("already known"));
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockResolvedValueOnce(matchingTx() as never)
      .mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
  });

  it("throws when a rebroadcast returns a different hash", async () => {
    const intent = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce("0xdead" as Hex);
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: txHash }),
    );
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toThrow(
      /broadcast hash mismatch/,
    );
  });

  it("rethrows AppError from rebroadcast send", async () => {
    const intent = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(
      new AppError(ApiErrorCode.TxPending),
    );
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: txHash }),
    );
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
  });

  it("propagates unexpected RPC errors", async () => {
    const getTxFail = seedBroadcast({ txHash });
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(new Error("getTx failed"));
    await expect(reconcileIntent(db, getTxFail.id, "dev-admin")).rejects.toThrow("getTx failed");

    vi.restoreAllMocks();
    const receiptFail = seedBroadcast({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockRejectedValueOnce(new Error("receipt failed"));
    await expect(reconcileIntent(db, receiptFail.id, "dev-admin")).rejects.toThrow(
      "receipt failed",
    );

    vi.restoreAllMocks();
    const lookupFail = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("dropped"));
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockRejectedValueOnce(new Error("lookup failed"));
    await expect(reconcileIntent(db, lookupFail.id, "dev-admin")).rejects.toThrow("lookup failed");

    vi.restoreAllMocks();
    const retryFail = seedBroadcast({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockRejectedValueOnce(new Error("retry failed"));
    await expect(reconcileIntent(db, retryFail.id, "dev-admin")).rejects.toThrow("retry failed");
  });

  it("fails closed when the stored raw tx does not match the intent", async () => {
    const badRaw = await signer.signTransaction({
      to: addressFromNumber(201),
      value,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      chainId: 31337,
    });
    const intent = seedBroadcast({ txHash: keccak256(badRaw), signedRawTx: badRaw });
    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(getIntentSignedRawTx(db, intent.id)).toBe(badRaw);
  });
});
