import { randomUUID } from "node:crypto";
import * as auditLog from "src/audit/log.js";
import * as broadcast from "src/chain/broadcast.js";
import * as buildTransferTx from "src/chain/buildTransferTx.js";
import { listAuditEventsForIntent } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import * as intentsDb from "src/db/intents.js";
import { createIntent } from "src/db/intents.js";
import { createWallet } from "src/db/wallets.js";
import { ApiErrorCode, Asset, AuditEventType, IntentStatus } from "src/domain/types.js";
import { executeIntent } from "src/services/executeIntent.js";
import {
  acquireExecution,
  isExecutionInFlight,
  resetExecutionLock,
} from "src/services/executionLock.js";
import { reconcileIntent } from "src/services/reconcileIntent.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex, SignerProvider } from "src/signers/types.js";
import { SignerBackend } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { AppError } from "src/utils/errors.js";
import { keccak256 } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = openDb(`./data/test-execute-${Date.now()}.db`);
const localSigner = new LocalKeySigner(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const from = await localSigner.getAddress();
const to = addressFromNumber(200);
const value = 10n ** 15n;
const sampleUnsigned = {
  to,
  value,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  chainId: 31337,
};
const signedRaw = await localSigner.signTransaction(sampleUnsigned);
const predictedHash = keccak256(signedRaw);
const mismatchedRaw = await localSigner.signTransaction({
  ...sampleUnsigned,
  to: addressFromNumber(201),
});

const stubSigner: SignerProvider = {
  name: SignerBackend.Local,
  getAddress: async () => from,
  signTransaction: async () => signedRaw,
};

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutionLock();
});

function seedApprovedIntent() {
  const wallet = createWallet(db, {
    id: randomUUID(),
    address: from,
    createdAt: new Date().toISOString(),
  });
  const intent = createIntent(db, {
    id: randomUUID(),
    fromWalletId: wallet.id,
    to,
    value,
    asset: Asset.Eth,
    initiatorId: "dev-initiator",
    status: IntentStatus.Approved,
    createdAt: new Date().toISOString(),
  });
  return { wallet, intent };
}

describe("executeIntent edge cases", () => {
  it("throws NotFound when the from-wallet is missing", async () => {
    const intent = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("throws AlreadyClaimed when the claim update races", async () => {
    const { intent } = seedApprovedIntent();

    vi.spyOn(intentsDb, "claimIntentForExecution").mockReturnValueOnce(false);

    try {
      await executeIntent(db, stubSigner, intent.id, "dev-admin");
      expect.unreachable("expected AppError");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) expect(err.code).toBe(ApiErrorCode.AlreadyClaimed);
    }
  });

  it("throws AlreadyClaimed when the wallet already has a broadcast intent", async () => {
    const { wallet, intent: first } = seedApprovedIntent();
    const second = createIntent(db, {
      id: randomUUID(),
      fromWalletId: wallet.id,
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    expect(intentsDb.claimIntentForExecution(db, first.id)).toBe(true);

    await expect(executeIntent(db, stubSigner, second.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.AlreadyClaimed,
    });
    expect(intentsDb.getIntent(db, second.id)?.status).toBe(IntentStatus.Approved);
  });

  it("throws AlreadyClaimed when the unique index rejects a second wallet broadcast", async () => {
    const { wallet, intent: first } = seedApprovedIntent();
    const second = createIntent(db, {
      id: randomUUID(),
      fromWalletId: wallet.id,
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    expect(intentsDb.claimIntentForExecution(db, first.id)).toBe(true);
    vi.spyOn(intentsDb, "walletHasBroadcastIntent").mockReturnValue(false);

    await expect(executeIntent(db, stubSigner, second.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.AlreadyClaimed,
    });
    expect(intentsDb.getIntent(db, second.id)?.status).toBe(IntentStatus.Approved);
  });

  it("throws InvalidStatus when intent is not approved", async () => {
    const intent = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    });

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
  });

  it("throws NotFound when intent is missing", async () => {
    await expect(executeIntent(db, stubSigner, randomUUID(), "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("restores Approved when AppError is thrown before broadcast", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockRejectedValueOnce(
      new AppError(ApiErrorCode.InvalidStatus, "boom"),
    );

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });

  it("restores Approved when build/sign fails before broadcast", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockRejectedValueOnce(new Error("rpc down"));

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(/rpc down/);
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });

  it("restores Approved when signTransaction fails after a successful build", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    const signer: SignerProvider = {
      ...stubSigner,
      signTransaction: async () => {
        throw new Error("vendor down");
      },
    };

    await expect(executeIntent(db, signer, intent.id, "dev-admin")).rejects.toThrow(/vendor down/);
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.some((e) => e.type === AuditEventType.SignRequested)).toBe(false);
    expect(events.some((e) => e.type === AuditEventType.ExecutionAborted)).toBe(true);
    expect(events.some((e) => e.type === AuditEventType.TxFailed)).toBe(false);
  });

  it("restores Approved when persist fails after sign", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(intentsDb, "persistBroadcastSignature").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(
      /disk full/,
    );
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    expect(intentsDb.getIntent(db, intent.id)?.txHash).toBeUndefined();
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBeUndefined();
  });

  it("leaves Broadcast when waitForTx fails after the hash is persisted", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockRejectedValueOnce(new Error("dropped"));

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(/dropped/);
    const updated = intentsDb.getIntent(db, intent.id);
    expect(updated?.status).toBe(IntentStatus.Broadcast);
    expect(updated?.txHash).toBe(predictedHash);
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBe(signedRaw);
  });

  it("does not unclaim after SignRequested when broadcast fails", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockRejectedValueOnce(new Error("timeout"));

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(/timeout/);
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(intentsDb.getIntent(db, intent.id)?.txHash).toBe(predictedHash);
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBe(signedRaw);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.some((e) => e.type === AuditEventType.SignRequested)).toBe(true);
    expect(events.some((e) => e.type === AuditEventType.TxBroadcast)).toBe(false);
  });

  it("keeps hash and raw when SignRequested cannot be persisted after sign", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(auditLog, "appendAuditEvent").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(
      /disk full/,
    );
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(intentsDb.getIntent(db, intent.id)?.txHash).toBe(predictedHash);
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBe(signedRaw);
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.SignRequested),
    ).toBe(false);
  });

  it("refuses to execute while another execution holds the lock", async () => {
    const { intent } = seedApprovedIntent();
    acquireExecution(intent.id);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ExecutionInProgress,
    });
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });

  it("wraps non-Error throw values from the execute path", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockRejectedValueOnce("string-failure");

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(
      /execute failed/,
    );
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });

  it("passes the intent id as the signer idempotency key", async () => {
    const { intent } = seedApprovedIntent();
    const signTransaction = vi.fn(async () => signedRaw);
    const signer: SignerProvider = { ...stubSigner, signTransaction };
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({
      status: "success",
      blockNumber: 1n,
    } as never);

    await executeIntent(db, signer, intent.id, "dev-admin");
    expect(signTransaction).toHaveBeenCalledWith(sampleUnsigned, { idempotencyKey: intent.id });
  });

  it("accepts a mixed-case hash from broadcast", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(
      `0x${predictedHash.slice(2).toUpperCase()}` as Hex,
    );
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({
      status: "success",
      blockNumber: 1n,
    } as never);

    const result = await executeIntent(db, stubSigner, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(result.txHash).toBe(predictedHash);
  });

  it("persists txHash on Broadcast before waiting for the receipt", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockImplementation(async () => {
      const row = intentsDb.getIntent(db, intent.id);
      expect(row?.status).toBe(IntentStatus.Broadcast);
      expect(row?.txHash).toBe(predictedHash);
      expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBe(signedRaw);
      expect(isExecutionInFlight(intent.id)).toBe(false);
      return { status: "success", blockNumber: 1n } as never;
    });

    await executeIntent(db, stubSigner, intent.id, "dev-admin");
    const updated = intentsDb.getIntent(db, intent.id);
    expect(updated?.status).toBe(IntentStatus.Confirmed);
    expect(updated?.txHash).toBe(predictedHash);
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBeUndefined();

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.map((e) => e.type)).toEqual([
      AuditEventType.SignRequested,
      AuditEventType.TxBroadcast,
      AuditEventType.TxConfirmed,
    ]);
  });

  it("throws NotFound when the intent disappears after confirmation", async () => {
    const { wallet, intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({
      status: "success",
      blockNumber: 1n,
    } as never);
    vi.spyOn(intentsDb, "claimIntentForExecution").mockReturnValueOnce(true);
    vi.spyOn(intentsDb, "persistBroadcastSignature").mockReturnValueOnce(true);
    vi.spyOn(intentsDb, "getIntent")
      .mockReturnValueOnce({ ...intent, fromWalletId: wallet.id, status: IntentStatus.Approved })
      .mockReturnValueOnce(undefined);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("marks Failed and emits TxFailed when the receipt is reverted", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({
      status: "reverted",
      blockNumber: 12n,
    } as never);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxReverted,
    });
    const updated = intentsDb.getIntent(db, intent.id);
    expect(updated?.status).toBe(IntentStatus.Failed);
    expect(updated?.txHash).toBe(predictedHash);

    const events = listAuditEventsForIntent(db, intent.id);
    expect(events.filter((e) => e.type === AuditEventType.TxFailed)).toHaveLength(1);
    expect(events.some((e) => e.type === AuditEventType.ReconcileMismatch)).toBe(false);
  });

  it("marks Failed when the receipt status is neither success nor reverted", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({
      status: "unknown",
      blockNumber: 12n,
    } as never);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.TxReverted,
    });
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.TxFailed),
    ).toBe(true);
  });

  it("unclaims and does not broadcast when the signed payload does not match the intent", async () => {
    const { intent } = seedApprovedIntent();
    const signer: SignerProvider = {
      ...stubSigner,
      signTransaction: async () => mismatchedRaw,
    };
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    const send = vi.spyOn(broadcast, "broadcastSignedTx");

    await expect(executeIntent(db, signer, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ReconcileMismatch,
    });
    expect(send).not.toHaveBeenCalled();
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBeUndefined();
    expect(
      listAuditEventsForIntent(db, intent.id).some((e) => e.type === AuditEventType.TxConfirmed),
    ).toBe(false);
  });

  it("does not send when persist loses the claim", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(intentsDb, "persistBroadcastSignature").mockReturnValueOnce(false);
    const send = vi.spyOn(broadcast, "broadcastSignedTx");

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
    expect(send).not.toHaveBeenCalled();
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    expect(intentsDb.getIntent(db, intent.id)?.txHash).toBeUndefined();
  });

  it("confirms from the receipt without a getTx match check", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({
      status: "success",
      blockNumber: 1n,
    } as never);
    const getTx = vi.spyOn(broadcast, "getTx");

    const result = await executeIntent(db, stubSigner, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(getTx).not.toHaveBeenCalled();
  });

  it("allows reconcile to confirm while waitForTx is still in flight", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "getTx").mockResolvedValue({
      to,
      from,
      value,
      input: "0x",
    } as never);
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValue({
      status: "success",
      blockNumber: 1n,
    } as never);
    vi.spyOn(broadcast, "waitForTx").mockImplementation(async () => {
      expect(isExecutionInFlight(intent.id)).toBe(false);
      const rec = await reconcileIntent(db, intent.id, "dev-admin");
      expect(rec.intent.status).toBe(IntentStatus.Confirmed);
      return { status: "success", blockNumber: 1n } as never;
    });

    const result = await executeIntent(db, stubSigner, intent.id, "dev-admin");
    expect(result.intent.status).toBe(IntentStatus.Confirmed);
    expect(
      listAuditEventsForIntent(db, intent.id).filter((e) => e.type === AuditEventType.TxConfirmed),
    ).toHaveLength(1);
  });

  it("does not drop reconcile's lock when execute finishes after persist", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);

    let failWait!: (err: Error) => void;
    let waitStarted!: () => void;
    const sawWait = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const waiting = new Promise<never>((_, reject) => {
      failWait = reject;
    });
    vi.spyOn(broadcast, "waitForTx").mockImplementation(async () => {
      waitStarted();
      return waiting;
    });

    let sawGetTx!: () => void;
    let releaseTx!: (tx: unknown) => void;
    const getTxStarted = new Promise<void>((resolve) => {
      sawGetTx = resolve;
    });
    const txPending = new Promise((resolve) => {
      releaseTx = resolve;
    });
    vi.spyOn(broadcast, "getTx").mockImplementation(async () => {
      sawGetTx();
      return txPending as never;
    });
    vi.spyOn(broadcast, "getTxReceipt").mockResolvedValue({
      status: "success",
      blockNumber: 1n,
    } as never);

    const executePromise = executeIntent(db, stubSigner, intent.id, "dev-admin");
    await sawWait;

    const reconcilePromise = reconcileIntent(db, intent.id, "dev-admin");
    await getTxStarted;
    expect(isExecutionInFlight(intent.id)).toBe(true);

    failWait(new Error("dropped"));
    await expect(executePromise).rejects.toThrow(/dropped/);

    expect(isExecutionInFlight(intent.id)).toBe(true);
    try {
      acquireExecution(intent.id);
      expect.unreachable("expected ExecutionInProgress");
    } catch (err) {
      expect(err).toMatchObject({ code: ApiErrorCode.ExecutionInProgress });
    }

    releaseTx({ to, from, value, input: "0x" });
    const rec = await reconcilePromise;
    expect(rec.intent.status).toBe(IntentStatus.Confirmed);
    expect(isExecutionInFlight(intent.id)).toBe(false);
  });
});
