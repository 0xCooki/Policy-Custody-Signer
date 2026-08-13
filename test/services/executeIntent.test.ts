import { randomUUID } from "node:crypto";
import * as broadcast from "src/chain/broadcast.js";
import * as buildTransferTx from "src/chain/buildTransferTx.js";
import { openDb } from "src/db/client.js";
import * as intentsDb from "src/db/intents.js";
import { createIntent } from "src/db/intents.js";
import { createWallet } from "src/db/wallets.js";
import { ApiErrorCode, Asset, IntentStatus } from "src/domain/types.js";
import { executeIntent } from "src/services/executeIntent.js";
import type { Hex, SignerProvider, UnsignedTx } from "src/signers/types.js";
import { SignerBackend } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { AppError } from "src/utils/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = openDb(`./data/test-execute-${Date.now()}.db`);

const stubSigner: SignerProvider = {
  name: SignerBackend.Local,
  getAddress: async () => addressFromNumber(1),
  signTransaction: async (_tx: UnsignedTx) => "0xdead" as Hex,
};

const sampleUnsigned = {
  to: addressFromNumber(200),
  value: 10n ** 15n,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  chainId: 31337,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function seedApprovedIntent() {
  const wallet = createWallet(db, {
    id: randomUUID(),
    address: addressFromNumber(2),
    createdAt: new Date().toISOString(),
  });
  const intent = createIntent(db, {
    id: randomUUID(),
    fromWalletId: wallet.id,
    to: addressFromNumber(200),
    value: 10n ** 15n,
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

  it("marks Failed when waitForTx fails after broadcast", async () => {
    const { intent } = seedApprovedIntent();
    const txHash = "0xabc" as Hex;
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "waitForTx").mockRejectedValueOnce(new Error("dropped"));

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(/dropped/);
    const updated = intentsDb.getIntent(db, intent.id);
    expect(updated?.status).toBe(IntentStatus.Failed);
    expect(updated?.txHash).toBe(txHash);
  });

  it("wraps non-Error throw values from the execute path", async () => {
    const { intent } = seedApprovedIntent();
    vi.spyOn(buildTransferTx, "buildTransferTx").mockRejectedValueOnce("string-failure");

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toThrow(
      /execute failed/,
    );
    expect(intentsDb.getIntent(db, intent.id)?.status).toBe(IntentStatus.Approved);
  });

  it("throws NotFound when the intent disappears after confirmation", async () => {
    const { wallet, intent } = seedApprovedIntent();
    const txHash = "0xdef" as Hex;
    vi.spyOn(buildTransferTx, "buildTransferTx").mockResolvedValueOnce(sampleUnsigned);
    vi.spyOn(broadcast, "broadcastSignedTx").mockResolvedValueOnce(txHash);
    vi.spyOn(broadcast, "waitForTx").mockResolvedValueOnce({} as never);
    vi.spyOn(intentsDb, "claimIntentForExecution").mockReturnValueOnce(true);
    vi.spyOn(intentsDb, "updateIntentExecution").mockImplementation(() => {});
    vi.spyOn(intentsDb, "getIntent")
      .mockReturnValueOnce({ ...intent, fromWalletId: wallet.id, status: IntentStatus.Approved })
      .mockReturnValueOnce(undefined);

    await expect(executeIntent(db, stubSigner, intent.id, "dev-admin")).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
  });
});
