import { randomUUID } from "node:crypto";
import { openDb } from "src/db/client.js";
import * as intentsDb from "src/db/intents.js";
import { createIntent } from "src/db/intents.js";
import { createWallet } from "src/db/wallets.js";
import { ApiErrorCode, Asset, IntentStatus, PolicyReason } from "src/domain/types.js";
import type { PolicyConfig } from "src/policy/types.js";
import { approveIntent } from "src/services/approveIntent.js";
import { addressFromNumber } from "src/utils/address.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const db = openDb(`./data/test-approve-${Date.now()}.db`);

const policy: PolicyConfig = {
  maxValue: 10n ** 18n,
  allowlist: [addressFromNumber(200)],
  quorum: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function seedPendingIntent(initiatorId = "dev-initiator") {
  const wallet = createWallet(db, {
    id: randomUUID(),
    address: addressFromNumber(1),
    createdAt: new Date().toISOString(),
  });
  const intent = createIntent(db, {
    id: randomUUID(),
    fromWalletId: wallet.id,
    to: addressFromNumber(200),
    value: 10n ** 15n,
    asset: Asset.Eth,
    initiatorId,
    status: IntentStatus.Pending,
    createdAt: new Date().toISOString(),
  });
  return intent;
}

describe("approveIntent", () => {
  it("approves and marks quorum met", () => {
    const intent = seedPendingIntent();
    const result = approveIntent(db, policy, {
      intentId: intent.id,
      approverId: "dev-approver",
    });
    expect(result.quorumMet).toBe(true);
    expect(result.intent.status).toBe(IntentStatus.Approved);
  });

  it("throws NotFound for a missing intent", () => {
    expect(() =>
      approveIntent(db, policy, { intentId: randomUUID(), approverId: "dev-approver" }),
    ).toThrow(expect.objectContaining({ code: ApiErrorCode.NotFound }));
  });

  it("throws InvalidStatus when intent is not pending", () => {
    const intent = seedPendingIntent();
    intentsDb.updateIntentStatus(db, intent.id, IntentStatus.Approved);
    expect(() =>
      approveIntent(db, policy, { intentId: intent.id, approverId: "dev-approver" }),
    ).toThrow(expect.objectContaining({ code: ApiErrorCode.InvalidStatus }));
  });

  it("rejects self-approval", () => {
    const intent = seedPendingIntent("dev-approver");
    expect(() =>
      approveIntent(db, policy, { intentId: intent.id, approverId: "dev-approver" }),
    ).toThrow(expect.objectContaining({ code: PolicyReason.SelfApproval }));
  });

  it("throws NotFound when the intent disappears after update", () => {
    const intent = seedPendingIntent();
    vi.spyOn(intentsDb, "getIntent").mockReturnValueOnce(intent).mockReturnValueOnce(undefined);

    expect(() =>
      approveIntent(db, policy, { intentId: intent.id, approverId: "dev-approver" }),
    ).toThrow(expect.objectContaining({ code: ApiErrorCode.NotFound }));
  });
});
