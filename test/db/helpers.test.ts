import { randomUUID } from "node:crypto";
import { createApproval, listApprovalsForIntent } from "src/db/approvals.js";
import { openDb } from "src/db/client.js";
import {
  claimIntentForExecution,
  createIntent,
  getIntent,
  getIntentSignedRawTx,
  persistBroadcastSignature,
  transitionBroadcastIntent,
  unclaimBroadcastIntent,
  updateIntentStatus,
} from "src/db/intents.js";
import { createWallet, getWallet, listWallets } from "src/db/wallets.js";
import { Asset, IntentStatus } from "src/domain/types.js";
import type { Hex } from "src/signers/types.js";
import { addressFromNumber } from "test/helpers/json.js";
import { describe, expect, it } from "vitest";

const db = openDb(`./data/test-db-${Date.now()}.db`);

describe("db wallets", () => {
  it("creates, gets, and lists wallets", () => {
    const wallet = createWallet(db, {
      id: randomUUID(),
      address: addressFromNumber(1),
      createdAt: new Date().toISOString(),
    });

    expect(getWallet(db, wallet.id)).toEqual(wallet);
    expect(getWallet(db, randomUUID())).toBeUndefined();
    expect(listWallets(db).some((w) => w.id === wallet.id)).toBe(true);
  });
});

describe("db approvals", () => {
  it("creates, gets, and lists approvals for an intent", () => {
    const intentId = randomUUID();
    const approval = createApproval(db, {
      id: randomUUID(),
      intentId,
      approverId: "dev-approver",
      createdAt: new Date().toISOString(),
    });

    expect(listApprovalsForIntent(db, intentId)).toEqual([approval]);
    expect(listApprovalsForIntent(db, randomUUID())).toEqual([]);
  });

  it("rejects duplicate (intentId, approverId) pairs", () => {
    const intentId = randomUUID();
    createApproval(db, {
      id: randomUUID(),
      intentId,
      approverId: "dev-approver",
      createdAt: new Date().toISOString(),
    });

    expect(() =>
      createApproval(db, {
        id: randomUUID(),
        intentId,
        approverId: "dev-approver",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

function seedApproved() {
  return createIntent(db, {
    id: randomUUID(),
    fromWalletId: randomUUID(),
    to: addressFromNumber(200),
    value: 10n ** 15n,
    asset: Asset.Eth,
    initiatorId: "dev-initiator",
    status: IntentStatus.Approved,
    createdAt: new Date().toISOString(),
  });
}

describe("db intents", () => {
  it("creates, gets, updates, and claims an intent", () => {
    const created = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    });

    expect(getIntent(db, created.id)).toEqual(created);
    expect(getIntent(db, randomUUID())).toBeUndefined();

    updateIntentStatus(db, created.id, IntentStatus.Approved);
    expect(getIntent(db, created.id)?.status).toBe(IntentStatus.Approved);

    expect(claimIntentForExecution(db, created.id)).toBe(true);
    expect(getIntent(db, created.id)?.status).toBe(IntentStatus.Broadcast);
    expect(claimIntentForExecution(db, created.id)).toBe(false);
  });

  it("persists, unclaims, and transitions a broadcast", () => {
    const created = seedApproved();
    expect(persistBroadcastSignature(db, created.id, "0xabc" as Hex, "0xdead" as Hex)).toBe(false);
    expect(claimIntentForExecution(db, created.id)).toBe(true);
    expect(unclaimBroadcastIntent(db, created.id)).toBe(true);

    expect(claimIntentForExecution(db, created.id)).toBe(true);
    expect(persistBroadcastSignature(db, created.id, "0xabc" as Hex, "0xdead" as Hex)).toBe(true);
    expect(getIntentSignedRawTx(db, created.id)).toBe("0xdead");
    expect(unclaimBroadcastIntent(db, created.id)).toBe(false);
    expect(persistBroadcastSignature(db, created.id, "0xdef" as Hex, "0xbeef" as Hex)).toBe(false);

    expect(transitionBroadcastIntent(db, created.id, IntentStatus.Confirmed, "0xabc" as Hex)).toBe(
      true,
    );
    expect(getIntent(db, created.id)?.status).toBe(IntentStatus.Confirmed);
    expect(getIntentSignedRawTx(db, created.id)).toBeUndefined();
    expect(transitionBroadcastIntent(db, created.id, IntentStatus.Failed, "0xabc" as Hex)).toBe(
      false,
    );
  });

  it("rejects a second Broadcast row for the same wallet", () => {
    const fromWalletId = randomUUID();
    const first = createIntent(db, {
      id: randomUUID(),
      fromWalletId,
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    const second = createIntent(db, {
      id: randomUUID(),
      fromWalletId,
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-initiator",
      status: IntentStatus.Approved,
      createdAt: new Date().toISOString(),
    });
    expect(claimIntentForExecution(db, first.id)).toBe(true);
    expect(() => claimIntentForExecution(db, second.id)).toThrow();
    expect(getIntent(db, second.id)?.status).toBe(IntentStatus.Approved);
  });
});
