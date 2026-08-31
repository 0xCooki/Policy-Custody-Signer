import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createApproval, getApproval, listApprovalsForIntent } from "src/db/approvals.js";
import { openDb } from "src/db/client.js";
import {
  claimIntentForExecution,
  createIntent,
  getIntent,
  getIntentSignedRawTx,
  persistBroadcastSignature,
  transitionBroadcastIntent,
  unclaimBroadcastIntent,
  updateIntentExecution,
  updateIntentStatus,
} from "src/db/intents.js";
import { migrate } from "src/db/schema.js";
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

    const txHash = "0xabc" as Hex;
    expect(claimIntentForExecution(db, created.id)).toBe(true);
    expect(getIntent(db, created.id)?.status).toBe(IntentStatus.Broadcast);
    expect(claimIntentForExecution(db, created.id)).toBe(false);

    updateIntentExecution(db, created.id, IntentStatus.Confirmed, txHash);
    const confirmed = getIntent(db, created.id);
    expect(confirmed?.status).toBe(IntentStatus.Confirmed);
    expect(confirmed?.txHash).toBe(txHash);
    expect(confirmed).not.toHaveProperty("signedRawTx");
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

describe("schema migrate", () => {
  it("adds signed_raw_tx and the one-broadcast index", () => {
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE intents (
        id TEXT PRIMARY KEY NOT NULL,
        from_wallet_id TEXT NOT NULL,
        to_address TEXT NOT NULL,
        value TEXT NOT NULL,
        asset TEXT NOT NULL,
        initiator_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        created_at TEXT NOT NULL
      );
    `);
    migrate(legacy);
    const columns = legacy.prepare(`PRAGMA table_info(intents)`).all() as { name: string }[];
    expect(columns.some((c) => c.name === "signed_raw_tx")).toBe(true);
    const indexes = legacy.prepare(`PRAGMA index_list(intents)`).all() as { name: string }[];
    expect(indexes.some((i) => i.name === "intents_one_broadcast_per_wallet")).toBe(true);
  });
});
