import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "src/audit/log.js";
import * as broadcast from "src/chain/broadcast.js";
import { listAuditEventsForIntent } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import {
  claimIntentForExecution,
  createIntent,
  getIntent,
  getIntentSignedRawTx,
  transitionBroadcastIntent,
  updateIntentExecution,
} from "src/db/intents.js";
import { createWallet } from "src/db/wallets.js";
import { ApiErrorCode, Asset, AuditEventType, IntentStatus } from "src/domain/types.js";
import {
  acquireExecution,
  isExecutionInFlight,
  resetExecutionLock,
} from "src/services/executionLock.js";
import { reconcileIntent } from "src/services/reconcileIntent.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = openDb(`./data/test-reconcile-${Date.now()}.db`);
const signer = new LocalKeySigner(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const from = await signer.getAddress();
const to = addressFromNumber(200);
const value = 10n ** 15n;
const unsignedTx = {
  to,
  value,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  chainId: 31337,
};
const signedRawTx = await signer.signTransaction(unsignedTx);
const txHash = keccak256(signedRawTx);
const mismatchedRawTx = await signer.signTransaction({ ...unsignedTx, to: addressFromNumber(201) });

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutionLock();
});

function seedBroadcastIntent(opts: { txHash?: Hex; signedRawTx?: Hex } = {}) {
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
    updateIntentExecution(db, created.id, IntentStatus.Broadcast, opts.txHash, opts.signedRawTx);
  }
  const intent = getIntent(db, created.id);
  if (!intent) throw new Error("seed failed");
  return intent;
}

function matchingTx(hash: Hex = txHash) {
  return { to, from, value, hash, input: "0x" };
}

function mockMatchingChain(hash: Hex = txHash) {
  vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx(hash) as never);
  vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
    status: "success",
    to,
    blockNumber: 12n,
  } as never);
}

function mockTxMissing(hash: Hex = txHash) {
  return vi.spyOn(broadcast, "getTx").mockRejectedValue(new TransactionNotFoundError({ hash }));
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

  it.each([IntentStatus.Confirmed, IntentStatus.Failed] as const)(
    "returns the stored row when the intent is already %s",
    async (status) => {
      const intent = seedBroadcastIntent({ txHash });
      expect(transitionBroadcastIntent(db, intent.id, status, txHash)).toBe(true);
      const getTx = vi.spyOn(broadcast, "getTx");

      const result = await reconcileIntent(db, intent.id, "dev-admin");
      expect(result.intent.status).toBe(status);
      expect(result.txHash).toBe(txHash);
      expect(getTx).not.toHaveBeenCalled();
    },
  );

  it("throws NotFound when the from-wallet is missing", async () => {
    const created = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to,
      value,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    expect(claimIntentForExecution(db, created.id)).toBe(true);

    await expect(reconcileIntent(db, created.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("unclaims back to Approved when nothing was signed", async () => {
    const intent = seedBroadcastIntent();
    const getTx = vi.spyOn(broadcast, "getTx");

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Approved);
    expect(result.txHash).toBeUndefined();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    expect(isExecutionInFlight(intent.id)).toBe(false);
    expect(getTx).not.toHaveBeenCalled();
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ExecutionAborted,
      ),
    ).toBe(true);
  });

  it.each([{ txHash: undefined }, { txHash }] as const)(
    "refuses to reconcile while execute is in-flight (hash=$txHash)",
    async ({ txHash: hash }) => {
      const intent = seedBroadcastIntent(hash === undefined ? {} : { txHash: hash });
      acquireExecution(intent.id);

      await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
        code: ApiErrorCode.ExecutionInProgress,
      });
      expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
      expect(isExecutionInFlight(intent.id)).toBe(true);
    },
  );

  it("confirms from the intent txHash when the receipt matches", async () => {
    const intent = seedBroadcastIntent({ txHash });
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.TxConfirmed),
    ).toBe(true);
  });

  it.each([{ status: "reverted" }, { status: "unknown" }] as const)(
    "marks Failed when the receipt is $status",
    async ({ status }) => {
      const intent = seedBroadcastIntent({ txHash });
      vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
      vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
        status,
        to,
        blockNumber: 12n,
      } as never);

      await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
        code: ApiErrorCode.TxReverted,
      });
      expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
      expect(
        listAuditEventsForIntent(db, intent.id).filter((e) => e.type === AuditEventType.TxFailed),
      ).toHaveLength(1);
    },
  );

  it("leaves Broadcast and throws TxPending when the transaction is not yet available", async () => {
    const intent = seedBroadcastIntent({ txHash });
    mockTxMissing();

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("leaves Broadcast and throws TxPending when the receipt is not yet mined", async () => {
    const intent = seedBroadcastIntent({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("propagates RPC errors without failing the intent", async () => {
    const intent = seedBroadcastIntent({ txHash });
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(new Error("rpc down"));

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toThrow(/rpc down/);
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("emits ReconcileMismatch when the chain tx does not match the intent", async () => {
    const intent = seedBroadcastIntent({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      ...matchingTx(),
      to: addressFromNumber(201),
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to: addressFromNumber(201),
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(true);
  });

  it("confirms from a matching stored raw even when getTx returns a different destination", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      ...matchingTx(),
      to: addressFromNumber(201),
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to: addressFromNumber(201),
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("rebroadcasts the stored raw tx when the hash is not yet on chain, then confirms", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    const send = vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to,
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(send).toHaveBeenCalledWith(signedRawTx);
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(getIntentSignedRawTx(db, intent.id)).toBeUndefined();
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.TxBroadcast),
    ).toBe(true);
  });

  it("leaves Broadcast and throws TxPending after rebroadcast before the tx is queryable", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    mockTxMissing();

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(
      listAuditEventsForIntent(db, intent.id).filter((e) => e.type === AuditEventType.TxBroadcast),
    ).toHaveLength(1);
  });

  it("treats an already-known send as success when the tx is on chain", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("already known"));
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockResolvedValue(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to,
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.TxBroadcast),
    ).toBe(true);
  });

  it("does not rebroadcast when there is a hash but no stored raw tx", async () => {
    const intent = seedBroadcastIntent({ txHash });
    const send = vi.spyOn(broadcast, "broadcastSignedTx");
    mockTxMissing();

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(send).not.toHaveBeenCalled();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("derives the hash from the stored raw tx when the row hash is missing", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    db.prepare(`UPDATE intents SET tx_hash = NULL WHERE id = ?`).run(intent.id);
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntent(db, intent.id)?.txHash).toBe(txHash);
  });

  it("fails closed when the stored raw tx does not hash to the stored tx hash", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx: "0xbeef" as Hex });
    const getTx = vi.spyOn(broadcast, "getTx");

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
    expect(getTx).not.toHaveBeenCalled();
  });

  it("does not emit a second TxConfirmed when another writer already confirmed", async () => {
    const intent = seedBroadcastIntent({ txHash });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce(matchingTx() as never);
    vi.spyOn(broadcast, "getTxReceipt").mockImplementation(async () => {
      updateIntentExecution(db, intent.id, IntentStatus.Confirmed, txHash);
      appendAuditEvent(db, {
        type: AuditEventType.TxConfirmed,
        payload: { intentId: intent.id, txHash },
        actor: "other",
      });
      return { status: "success", to, blockNumber: 12n } as never;
    });

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(
      listAuditEventsForIntent(db, intent.id).filter((e) => e.type === AuditEventType.TxConfirmed),
    ).toHaveLength(1);
  });

  it("does not overwrite Confirmed with Failed on a chain mismatch race", async () => {
    const intent = seedBroadcastIntent({ txHash });
    vi.spyOn(broadcast, "getTx").mockImplementation(async () => {
      updateIntentExecution(db, intent.id, IntentStatus.Confirmed, txHash);
      return { ...matchingTx(), to: addressFromNumber(201) } as never;
    });
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to: addressFromNumber(201),
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("treats mixed-case stored hashes as equal to the raw keccak", async () => {
    const upper = `0x${txHash.slice(2).toUpperCase()}` as Hex;
    const intent = seedBroadcastIntent({ txHash: upper, signedRawTx });
    mockMatchingChain(upper);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(getIntentSignedRawTx(db, intent.id)).toBeUndefined();
  });

  it("leaves Broadcast and throws TxPending when rebroadcast fails and the tx is still missing", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("nonce too low"));
    mockTxMissing();

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("leaves Broadcast when rebroadcast returns a different hash", async () => {
    const intent = seedBroadcastIntent({ txHash, signedRawTx });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce("0xabc" as Hex);
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toThrow(
      /broadcast hash mismatch/,
    );
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it.each([
    { name: "pays a different destination", raw: mismatchedRawTx },
    { name: "is unparseable", raw: "0xdead" as Hex },
  ])("does not rebroadcast a stored raw tx that $name", async ({ raw }) => {
    const hash = keccak256(raw);
    const intent = seedBroadcastIntent({ txHash: hash, signedRawTx: raw });
    const send = vi.spyOn(broadcast, "broadcastSignedTx");
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(new TransactionNotFoundError({ hash }));

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(send).not.toHaveBeenCalled();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });
});
