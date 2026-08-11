import { randomUUID } from "node:crypto";
import { createApproval, getApproval, listApprovalsForIntent } from "src/db/approvals.js";
import { openDb } from "src/db/client.js";
import { createWallet, getWallet, listWallets } from "src/db/wallets.js";
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
