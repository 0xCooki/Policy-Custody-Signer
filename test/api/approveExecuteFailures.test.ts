import { randomUUID } from "node:crypto";
import { app } from "src/api/index.js";
import { config } from "src/config.js";
import { openDb } from "src/db/client.js";
import { claimIntentForExecution, createIntent } from "src/db/intents.js";
import { ApiErrorCode, Asset, IntentStatus, PolicyReason } from "src/domain/types.js";
import type { PolicyConfig } from "src/policy/types.js";
import { approveIntent } from "src/services/approveIntent.js";
import type { Address } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { AppError } from "src/utils/errors.js";
import { describe, expect, it } from "vitest";

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};
const approverHeaders = { Authorization: "Bearer dev-approver" };

const policyConfig: PolicyConfig = {
  maxValue: config.policy.maxValue,
  allowlist: config.policy.allowlist as Address[],
  quorum: config.policy.quorum,
};

async function createPendingIntent(): Promise<{ id: string }> {
  const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
  expect(walletRes.status).toBe(201);
  const wallet = await walletRes.json();

  const intentRes = await app.request("/intents", {
    method: "POST",
    headers: initiatorHeaders,
    body: JSON.stringify({
      fromWalletId: wallet.id,
      to: addressFromNumber(200),
      value: (10n ** 15n).toString(),
    }),
  });
  expect(intentRes.status).toBe(201);
  const intent = await intentRes.json();
  return { id: intent.id as string };
}

describe("Approve and execute failures", () => {
  it("returns 404 when approving a missing intent", async () => {
    const res = await app.request(`/intents/${randomUUID()}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ApiErrorCode.NotFound });
  });

  it("returns 403 for duplicate approval while still pending", () => {
    const db = openDb();
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
    const highQuorum = { ...policyConfig, quorum: 2 };

    approveIntent(db, highQuorum, {
      intentId: intent.id,
      approverId: "dev-approver",
    });

    try {
      approveIntent(db, highQuorum, {
        intentId: intent.id,
        approverId: "dev-approver",
      });
      expect.unreachable("expected AppError");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) expect(err.code).toBe(PolicyReason.DuplicateApproval);
    }
  });

  it("rejects self-approval via service with AppError", () => {
    const db = openDb();
    const intent = createIntent(db, {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "same-actor",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    });

    try {
      approveIntent(db, policyConfig, {
        intentId: intent.id,
        approverId: "same-actor",
      });
      expect.unreachable("expected AppError");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) expect(err.code).toBe(PolicyReason.SelfApproval);
    }
  });

  it("returns 400 when approving a non-pending intent", async () => {
    const intent = await createPendingIntent();
    const approved = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approved.status).toBe(200);

    const again = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: ApiErrorCode.InvalidStatus });
  });

  it("returns 400 when executing a pending (not approved) intent", async () => {
    const intent = await createPendingIntent();
    const res = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ApiErrorCode.InvalidStatus });
  });

  it("returns 400 when intent was already claimed for execution", async () => {
    const intent = await createPendingIntent();
    const approveRes = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approveRes.status).toBe(200);

    // claimIntentForExecution moves status to broadcast; execute then rejects as invalid_status
    // (AlreadyClaimed only surfaces under a true concurrent claim race).
    const db = openDb();
    expect(claimIntentForExecution(db, intent.id)).toBe(true);

    const res = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ApiErrorCode.InvalidStatus });
  });
});
