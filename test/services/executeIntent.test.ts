import { randomUUID } from "node:crypto";
import * as broadcast from "src/chain/broadcast.js";
import * as buildTransferTx from "src/chain/buildTransferTx.js";
import { listAuditEventsForIntent } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import * as intentsDb from "src/db/intents.js";
import { createIntent } from "src/db/intents.js";
import { createWallet } from "src/db/wallets.js";
import { ApiErrorCode, Asset, AuditEventType, IntentStatus } from "src/domain/types.js";
import { executeIntent } from "src/services/executeIntent.js";
import { acquireExecution, resetExecutionLock } from "src/services/executionLock.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex, SignerProvider } from "src/signers/types.js";
import { SignerBackend } from "src/signers/types.js";
import { addressFromNumber } from "test/helpers/json.js";
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

describe("executeIntent", () => {
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
    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("throws AlreadyClaimed when the claim update races", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(intentsDb, "claimIntentForExecution").mockReturnValueOnce(false);
    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.AlreadyClaimed,
    });
  });

  it("throws AlreadyClaimed when the wallet already has a broadcast intent", async () => {
    const { wallet, intent: first } = seedApprovedIntent();
    const second = createIntent(db, {
      id: randomUUID(),
      fromWalletId: wallet.id,
      to,
      value,
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

  it("throws InvalidStatus when intent is not approved", async () => {
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
    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
  });

  it("throws NotFound when intent is missing", async () => {
    await expect(executeIntent(db, stubSigner, randomUUID(), "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });

  it("restores Approved when build or sign fails", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockRejectedValueOnce(new Error("rpc down"));
    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(/rpc down/);
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
    expect(
      listAuditEventsForIntent(db, intent.id).some(
        (e) => e.type === AuditEventType.ExecutionAborted,
      ),
    ).toBe(true);
  });

  it("leaves Broadcast when waitForTx fails after persist", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(predictedHash);
    vi.spyOn(broadcast, "waitForTx").mockRejectedValueOnce(new Error("dropped"));

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(/dropped/);
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
    expect(intentsDb.getIntent(db, intent.id)?.txHash).toBe(predictedHash);
    expect(intentsDb.getIntentSignedRawTx(db, intent.id)).toBe(signedRaw);
  });

  it("refuses to execute while another execution holds the lock", async () => {
    const { intent } = seedApprovedIntent();
    acquireExecution(intent.id);
    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.ExecutionInProgress,
    });
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

  it("marks Failed when the receipt is reverted", async () => {
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
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Failed);
  });

  it("unclaims when the signed payload does not match the intent", async () => {
    const { intent } = seedApprovedIntent();
    const bad = await localSigner.signTransaction({
      ...sampleUnsigned,
      to: addressFromNumber(201),
    });
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    const send = vi.spyOn(broadcast, "broadcastSignedTx");

    await expect(
      executeIntent(
        db,
        { ...stubSigner, signTransaction: async () => bad },
        intent.id,
        "dev-admin",
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.ReconcileMismatch });
    expect(send).not.toHaveBeenCalled();
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });

  it("throws when the broadcast hash does not match the signed payload", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce("0xdead" as Hex);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(
      /broadcast hash mismatch/,
    );
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Broadcast);
  });

  it("throws InvalidStatus when persist fails after claim", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(intentsDb, "persistBroadcastSignature").mockReturnValueOnce(false);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.InvalidStatus,
    });
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });
});
