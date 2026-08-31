import { randomUUID } from "node:crypto";
import { app } from "src/api/index.js";
import { openDb } from "src/db/client.js";
import { updateIntentStatus } from "src/db/intents.js";
import { ApiErrorCode, IntentStatus } from "src/domain/types.js";
import * as reconcileIntentService from "src/services/reconcileIntent.js";
import { addressFromNumber } from "src/utils/address.js";
import { AppError } from "src/utils/errors.js";
import {
  type IntentJson,
  type ReconcileJson,
  readJson,
  type WalletJson,
} from "test/helpers/json.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};
const approverHeaders = { Authorization: "Bearer dev-approver" };

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("Reconcile API", () => {
  it("returns 401 when the API key is missing", async () => {
    const res = await app.request(`/intents/${randomUUID()}/reconcile`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not admin", async () => {
    const intent = await createPendingIntent();
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: initiatorHeaders,
    });
    expect(res.status).toBe(403);
    const approver = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approver.status).toBe(403);
  });

  it("returns 404 when the intent is missing", async () => {
    const res = await app.request(`/intents/${randomUUID()}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the intent is not Broadcast", async () => {
    const intent = await createPendingIntent();
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ApiErrorCode.InvalidStatus });
  });

  it("returns 200 when the intent is already Confirmed", async () => {
    const intent = await createPendingIntent();
    updateIntentStatus(openDb(), intent.id, IntentStatus.Confirmed);
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    expect(await readJson<ReconcileJson>(res)).toMatchObject({
      intent: { id: intent.id, status: IntentStatus.Confirmed },
    });
  });

  it("returns 409 for pending / in-progress / mismatch", async () => {
    const intent = await createPendingIntent();
    vi.spyOn(reconcileIntentService, "reconcileIntent").mockRejectedValueOnce(
      new AppError(ApiErrorCode.TxPending),
    );
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: ApiErrorCode.TxPending });
  });
});
