import { randomUUID } from "node:crypto";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
