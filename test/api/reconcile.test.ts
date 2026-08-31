import { randomUUID } from "node:crypto";
import { app } from "src/api/index.js";
import { openDb } from "src/db/client.js";
import { updateIntentStatus } from "src/db/intents.js";
import { ApiErrorCode, Asset, IntentStatus } from "src/domain/types.js";
import * as reconcileIntentService from "src/services/reconcileIntent.js";
import type { Hex } from "src/signers/types.js";
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
    expect(await res.json()).toEqual({ error: ApiErrorCode.Unauthorized });
  });

  it("returns 403 when the caller is not admin", async () => {
    const intent = await createPendingIntent();
    const initiator = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: initiatorHeaders,
    });
    expect(initiator.status).toBe(403);
    expect(await initiator.json()).toEqual({ error: ApiErrorCode.Forbidden });

    const approver = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approver.status).toBe(403);
    expect(await approver.json()).toEqual({ error: ApiErrorCode.Forbidden });
  });

  it("returns 404 when the intent is missing", async () => {
    const res = await app.request(`/intents/${randomUUID()}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ApiErrorCode.NotFound });
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

  it.each([
    ApiErrorCode.TxReverted,
    ApiErrorCode.ReconcileMismatch,
    ApiErrorCode.TxPending,
    ApiErrorCode.ExecutionInProgress,
  ])("returns 409 when reconcile reports %s", async (code) => {
    const intent = await createPendingIntent();
    vi.spyOn(reconcileIntentService, "reconcileIntent").mockRejectedValueOnce(new AppError(code));
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: code });
  });

  it("returns 500 when reconcile throws a non-AppError", async () => {
    const intent = await createPendingIntent();
    vi.spyOn(reconcileIntentService, "reconcileIntent").mockRejectedValueOnce(
      new Error("rpc down"),
    );
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "rpc down" });
  });

  it("returns the confirmed intent and txHash on success", async () => {
    const intent = await createPendingIntent();
    vi.spyOn(reconcileIntentService, "reconcileIntent").mockResolvedValueOnce({
      intent: {
        id: intent.id,
        fromWalletId: "w",
        to: addressFromNumber(200),
        value: 10n ** 15n,
        asset: Asset.Eth,
        initiatorId: "dev-initiator",
        status: IntentStatus.Confirmed,
        txHash: "0xabc" as Hex,
        createdAt: new Date().toISOString(),
      },
      txHash: "0xabc" as Hex,
    });
    const res = await app.request(`/intents/${intent.id}/reconcile`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    expect(await readJson<ReconcileJson>(res)).toMatchObject({
      txHash: "0xabc",
      intent: { id: intent.id, status: IntentStatus.Confirmed },
    });
  });
});
