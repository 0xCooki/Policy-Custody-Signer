import { randomUUID } from "node:crypto";
import { createApproval, getApproval, listApprovalsForIntent } from "src/db/approvals.js";
import { openDb } from "src/db/client.js";
import {
  claimIntentForExecution,
  createIntent,
  getIntent,
  updateIntentExecution,
  updateIntentStatus,
} from "src/db/intents.js";
import { createWallet, getWallet, listWallets } from "src/db/wallets.js";
import { Asset, IntentStatus } from "src/domain/types.js";
import type { Hex } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
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

    expect(getApproval(db, approval.id)).toEqual(approval);
    expect(getApproval(db, randomUUID())).toBeUndefined();
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

    const txHash = "0xabc" as Hex;
    expect(claimIntentForExecution(db, created.id)).toBe(true);
    expect(getIntent(db, created.id)?.status).toBe(IntentStatus.Broadcast);
    expect(claimIntentForExecution(db, created.id)).toBe(false);

    updateIntentExecution(db, created.id, IntentStatus.Confirmed, txHash);
    const confirmed = getIntent(db, created.id);
    expect(confirmed?.status).toBe(IntentStatus.Confirmed);
    expect(confirmed?.txHash).toBe(txHash);
  });
});
