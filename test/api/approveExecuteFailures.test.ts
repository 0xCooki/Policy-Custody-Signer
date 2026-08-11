import { randomUUID } from "node:crypto";
import { app } from "src/api/index.js";
import { createApproval } from "src/db/approvals.js";
import { openDb } from "src/db/client.js";
import { claimIntentForExecution, createIntent } from "src/db/intents.js";
import { ApiErrorCode, Asset, IntentStatus, PolicyReason } from "src/domain/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { type IntentJson, readJson, type WalletJson } from "test/helpers/json.js";
import { describe, expect, it } from "vitest";

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};
const approverHeaders = { Authorization: "Bearer dev-approver" };

async function createPendingIntent(): Promise<{ id: string }> {
  const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
  expect(walletRes.status).toBe(201);
  const wallet = await readJson<WalletJson>(walletRes);

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
  const intent = await readJson<IntentJson>(intentRes);
  return { id: intent.id };
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

  it("returns 403 for duplicate approval while still pending", async () => {
    const intent = await createPendingIntent();
    const db = openDb();
    createApproval(db, {
      id: randomUUID(),
      intentId: intent.id,
      approverId: "dev-approver",
      createdAt: new Date().toISOString(),
    });

    const res = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PolicyReason.DuplicateApproval });
  });

  it("returns 403 for self-approval via HTTP", async () => {
    const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
    expect(walletRes.status).toBe(201);
    const wallet = await readJson<WalletJson>(walletRes);

    const db = openDb();
    const intent = createIntent(db, {
      id: randomUUID(),
      fromWalletId: wallet.id,
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "dev-approver",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    });

    const res = await app.request(`/intents/${intent.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PolicyReason.SelfApproval });
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

  it("returns 400 when executing an intent already moved past approved", async () => {
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
