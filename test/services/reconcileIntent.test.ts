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
  releaseExecution,
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

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutionLock();
});

function seedBroadcastIntent(opts: {
  txHash?: Hex;
  signedRawTx?: Hex;
  signRequested?: boolean;
  signRequestedHash?: Hex;
  txBroadcast?: Hex;
}) {
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
  if (opts.signRequested) {
    const payloadHash = opts.signRequestedHash ?? opts.txHash;
    appendAuditEvent(db, {
      type: AuditEventType.SignRequested,
      payload: {
        intentId: created.id,
        ...(payloadHash !== undefined ? { txHash: payloadHash } : {}),
      },
      actor: "dev-admin",
    });
  }
  if (opts.txBroadcast !== undefined) {
    appendAuditEvent(db, {
      type: AuditEventType.TxBroadcast,
      payload: { intentId: created.id, txHash: opts.txBroadcast },
      actor: "dev-admin",
    });
  }
  const intent = getIntent(db, created.id);
  if (!intent) throw new Error("seed failed");
  return { wallet, intent };
}

function mockMatchingChain(hash: Hex = txHash) {
  vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
    to,
    from,
    value,
    hash,
    input: "0x",
  } as never);
  vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
    status: "success",
    to,
    blockNumber: 12n,
  } as never);
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

  it("returns the stored row when the intent is already Confirmed", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    expect(transitionBroadcastIntent(db, intent.id, IntentStatus.Confirmed, txHash)).toBe(true);
    const getTx = vi.spyOn(broadcast, "getTx");

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getTx).not.toHaveBeenCalled();
  });

  it("returns the stored row when the intent is already Failed", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    expect(transitionBroadcastIntent(db, intent.id, IntentStatus.Failed, txHash)).toBe(true);
    const getTx = vi.spyOn(broadcast, "getTx");

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Failed);
    expect(result.txHash).toBe(txHash);
    expect(getTx).not.toHaveBeenCalled();
  });

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
    const { intent } = seedBroadcastIntent({});

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Approved);
    expect(result.txHash).toBeUndefined();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.some((e) => e.type === AuditEventType.TxFailed)).toBe(true);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(false);
  });

  it("releases the execution lock after unclaim so a later reconcile can run", async () => {
    const { intent } = seedBroadcastIntent({});

    await reconcileIntent(db, intent.id, "dev-admin");
    acquireExecution(intent.id);
    releaseExecution(intent.id);
  });

  it("refuses to reconcile while execute is still in-flight", async () => {
    const { intent } = seedBroadcastIntent({});
    acquireExecution(intent.id);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ExecutionInProgress,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(isExecutionInFlight(intent.id)).toBe(true);
  });

  it("refuses to reconcile a signed broadcast while execute is in-flight", async () => {
    const { intent } = seedBroadcastIntent({ signRequested: true });
    acquireExecution(intent.id);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ExecutionInProgress,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(isExecutionInFlight(intent.id)).toBe(true);
  });

  it("refuses to confirm from a hash while execute is in-flight", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    acquireExecution(intent.id);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ExecutionInProgress,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(isExecutionInFlight(intent.id)).toBe(true);
  });

  it("unclaims when SignRequested exists without a hash", async () => {
    const { intent } = seedBroadcastIntent({ signRequested: true });

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Approved);
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(false);
  });

  it("confirms from the SignRequested payload hash when the row has no hash", async () => {
    const { intent } = seedBroadcastIntent({ signRequested: true, signRequestedHash: txHash });
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntent(db, intent.id)?.txHash).toBe(txHash);
  });

  it("does not look up chain state when no hash can be recovered", async () => {
    const { intent } = seedBroadcastIntent({});
    const getTx = vi.spyOn(broadcast, "getTx");

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Approved);
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    expect(getTx).not.toHaveBeenCalled();
  });

  it("confirms from the intent txHash when the receipt matches", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.some((e) => e.type === AuditEventType.TxConfirmed)).toBe(true);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(false);
  });

  it("recovers the hash from the latest TxBroadcast audit row", async () => {
    const { intent } = seedBroadcastIntent({
      signRequested: true,
      txBroadcast: txHash,
    });
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntent(db, intent.id)?.txHash).toBe(txHash);
  });

  it("marks Failed and emits TxFailed when the receipt is reverted", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from,
      value,
      hash: txHash,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "reverted",
      to,
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxReverted,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.filter((e) => e.type === AuditEventType.TxFailed)).toHaveLength(1);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(false);
  });

  it("leaves Broadcast and throws TxPending when the transaction is not yet available", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("leaves Broadcast and throws TxPending when the receipt is not yet mined", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from,
      value,
      hash: txHash,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockRejectedValueOnce(
      new TransactionReceiptNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("propagates RPC errors without failing the intent", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(new Error("rpc down"));

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toThrow(/rpc down/);
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("emits ReconcileMismatch when chain to/value does not match the intent", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to: addressFromNumber(201),
      from,
      value,
      hash: txHash,
      input: "0x",
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

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(true);
    expect(events.some((e) => e.type === AuditEventType.TxConfirmed)).toBe(false);
  });

  it("emits ReconcileMismatch when chain value does not match the intent", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from,
      value: value + 1n,
      hash: txHash,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to,
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });

  it("emits ReconcileMismatch when chain from does not match the wallet", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from: addressFromNumber(99),
      value,
      hash: txHash,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to,
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });

  it("emits ReconcileMismatch when the chain tx has calldata", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from,
      value,
      hash: txHash,
      input: "0xabcd",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to,
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });

  it("confirms from a matching stored raw even when getTx returns a different destination", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to: addressFromNumber(201),
      from,
      value,
      hash: txHash,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to: addressFromNumber(201),
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("rebroadcasts the stored raw tx when the hash is not yet on chain, then confirms", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx, signRequested: true });
    const send = vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockResolvedValueOnce({
        to,
        from,
        value,
        hash: txHash,
        input: "0x",
      } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to,
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(send).toHaveBeenCalledWith(signedRawTx);
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntentSignedRawTx(db, intent.id)).toBeUndefined();
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.TxBroadcast),
    ).toBe(true);
  });

  it("leaves Broadcast and throws TxPending after rebroadcast before the tx is queryable", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx, signRequested: true });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "getTx").mockRejectedValue(new TransactionNotFoundError({ hash: txHash }));

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(
      listAuditEventsForIntent(db, intent.id).filter((e) => e.type === AuditEventType.TxBroadcast),
    ).toHaveLength(1);
  });

  it("treats an already-known send as success when the tx is on chain", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx, signRequested: true });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("already known"));
    vi.spyOn(broadcast, "getTx")
      .mockRejectedValueOnce(new TransactionNotFoundError({ hash: txHash }))
      .mockResolvedValue({
        to,
        from,
        value,
        hash: txHash,
        input: "0x",
      } as never);
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

  it("does not rebroadcast when SignRequested exists without a stored raw tx", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    const send = vi.spyOn(broadcast, "broadcastSignedTx");
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(send).not.toHaveBeenCalled();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("derives the hash from the stored raw tx when the row hash is missing", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx });
    db.prepare(`UPDATE intents SET tx_hash = NULL WHERE id = ?`).run(intent.id);
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntent(db, intent.id)?.txHash).toBe(txHash);
  });

  it("prefers keccak of the stored raw over a conflicting audit hash", async () => {
    const wrongHash = keccak256("0xbeef" as Hex);
    const { intent } = seedBroadcastIntent({
      txHash,
      signedRawTx,
      signRequested: true,
      signRequestedHash: wrongHash,
      txBroadcast: wrongHash,
    });
    db.prepare(`UPDATE intents SET tx_hash = NULL WHERE id = ?`).run(intent.id);
    mockMatchingChain();

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntent(db, intent.id)?.txHash).toBe(txHash);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("fails closed when the stored raw tx does not hash to the stored tx hash", async () => {
    const { intent } = seedBroadcastIntent({
      txHash,
      signedRawTx: "0xbeef" as Hex,
      signRequested: true,
    });
    const getTx = vi.spyOn(broadcast, "getTx");

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
    expect(getTx).not.toHaveBeenCalled();
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(true);
  });

  it("marks Failed and emits TxFailed when the receipt status is neither success nor reverted", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from,
      value,
      hash: txHash,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "unknown",
      to,
      blockNumber: 12n,
    } as never);

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxReverted,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.filter((e) => e.type === AuditEventType.TxFailed)).toHaveLength(1);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(false);
  });

  it("does not emit a second TxConfirmed when another writer already confirmed", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockResolvedValueOnce({
      to,
      from,
      value,
      hash: txHash,
      input: "0x",
    } as never);
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
    expect(result.txHash).toBe(txHash);
    expect(
      listAuditEventsForIntent(db, intent.id).filter((e) => e.type === AuditEventType.TxConfirmed),
    ).toHaveLength(1);
  });

  it("does not overwrite Confirmed with Failed on a chain mismatch race", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signRequested: true });
    vi.spyOn(broadcast, "getTx").mockImplementation(async () => {
      updateIntentExecution(db, intent.id, IntentStatus.Confirmed, txHash);
      return {
        to: addressFromNumber(201),
        from,
        value,
        hash: txHash,
        input: "0x",
      } as never;
    });
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValueOnce({
      status: "success",
      to: addressFromNumber(201),
      blockNumber: 12n,
    } as never);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(txHash);
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Confirmed);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("treats mixed-case stored hashes as equal to the raw keccak", async () => {
    const upper = `0x${txHash.slice(2).toUpperCase()}` as Hex;
    const { intent } = seedBroadcastIntent({
      txHash: upper,
      signedRawTx,
      signRequested: true,
    });
    mockMatchingChain(upper);

    const result = await reconcileIntent(db, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(getIntentSignedRawTx(db, intent.id)).toBeUndefined();
  });

  it("leaves Broadcast and throws TxPending when rebroadcast fails and the tx is still missing", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx, signRequested: true });
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("nonce too low"));
    vi.spyOn(broadcast, "getTx").mockRejectedValue(new TransactionNotFoundError({ hash: txHash }));

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxPending,
    });
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("leaves Broadcast when rebroadcast returns a different hash", async () => {
    const { intent } = seedBroadcastIntent({ txHash, signedRawTx, signRequested: true });
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce("0xabc" as Hex);
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: txHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toThrow(
      /broadcast hash mismatch/,
    );
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ReconcileMismatch,
      ),
    ).toBe(false);
  });

  it("does not rebroadcast a stored raw tx that pays a different destination", async () => {
    const otherRaw = await signer.signTransaction({ ...unsignedTx, to: addressFromNumber(201) });
    const otherHash = keccak256(otherRaw);
    const { intent } = seedBroadcastIntent({
      txHash: otherHash,
      signedRawTx: otherRaw,
      signRequested: true,
    });
    const send = vi.spyOn(broadcast, "broadcastSignedTx");
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: otherHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(send).not.toHaveBeenCalled();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });

  it("does not rebroadcast an unparseable stored raw tx", async () => {
    const garbage = "0xdead" as Hex;
    const garbageHash = keccak256(garbage);
    const { intent } = seedBroadcastIntent({
      txHash: garbageHash,
      signedRawTx: garbage,
      signRequested: true,
    });
    const send = vi.spyOn(broadcast, "broadcastSignedTx");
    vi.spyOn(broadcast, "getTx").mockRejectedValueOnce(
      new TransactionNotFoundError({ hash: garbageHash }),
    );

    await expect(reconcileIntent(db, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(send).not.toHaveBeenCalled();
    expect(getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });
});
