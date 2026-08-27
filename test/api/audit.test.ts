import { randomUUID } from "node:crypto";
import { app } from "src/api/index.js";
import { openDb } from "src/db/client.js";
import { createIntent } from "src/db/intents.js";
import { ApiErrorCode, Asset, AuditEventType, IntentStatus, Role } from "src/domain/types.js";
import { addressFromNumber } from "src/utils/address.js";
import {
  type ApproveJson,
  type AuditJson,
  type IntentJson,
  readJson,
  type WalletJson,
} from "test/helpers/json.js";
import { describe, expect, it } from "vitest";

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};
const approverHeaders = { Authorization: "Bearer dev-approver" };

describe("Audit API", () => {
  it("returns 401 when GET /audit has no API key", async () => {
    const res = await app.request("/audit");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: ApiErrorCode.Unauthorized });
  });

  it("returns 403 when GET /audit is not admin", async () => {
    const res = await app.request("/audit", { headers: { Authorization: "Bearer dev-initiator" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ApiErrorCode.Forbidden });
  });

  it("returns verified audit events for admin and intent-related events on GET", async () => {
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
    const created = await readJson<IntentJson>(intentRes);

    const approveRes = await app.request(`/intents/${created.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approveRes.status).toBe(200);
    const approved = await readJson<ApproveJson>(approveRes);
    expect(approved.intent.status).toBe(IntentStatus.Approved);

    const intentGet = await app.request(`/intents/${created.id}`, { headers: initiatorHeaders });
    expect(intentGet.status).toBe(200);
    const intentBody = await readJson<IntentJson>(intentGet);
    expect(intentBody.events?.map((e) => e.type)).toEqual([
      AuditEventType.IntentCreated,
      AuditEventType.IntentApproved,
    ]);
    expect(intentBody.events?.every((e) => e.payload.intentId === created.id)).toBe(true);
    expect(
      intentBody.events?.every((e) => !("actor" in e) && !("prevHash" in e) && !("eventHash" in e)),
    ).toBe(true);
    expect(intentBody.events?.every((e) => !("approverId" in e.payload))).toBe(true);

    const auditRes = await app.request("/audit", { headers: adminHeaders });
    expect(auditRes.status).toBe(200);
    const audit = await readJson<AuditJson>(auditRes);
    expect(audit.verified).toBe(true);
    expect(audit.events.length).toBeGreaterThanOrEqual(2);
    expect(audit.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([AuditEventType.IntentCreated, AuditEventType.IntentApproved]),
    );
    expect(audit.events.some((e) => e.role === Role.Initiator)).toBe(true);
    expect(audit.events.some((e) => e.role === Role.Approver)).toBe(true);
    expect(audit.events.every((e) => !("actor" in e))).toBe(true);
    expect(audit.events.every((e) => !("approverId" in e.payload))).toBe(true);
    expect(JSON.stringify(audit.events)).not.toMatch(/dev-initiator|dev-approver|dev-admin/);
    expect(audit.events.every((e) => typeof e.eventHash === "string")).toBe(true);
  });

  it("does not include another intent's audit rows on GET /intents/:id", async () => {
    const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
    expect(walletRes.status).toBe(201);
    const wallet = await readJson<WalletJson>(walletRes);

    const firstRes = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId: wallet.id,
        to: addressFromNumber(200),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(firstRes.status).toBe(201);
    const first = await readJson<IntentJson>(firstRes);

    const approveRes = await app.request(`/intents/${first.id}/approve`, {
      method: "POST",
      headers: approverHeaders,
    });
    expect(approveRes.status).toBe(200);

    const secondRes = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId: wallet.id,
        to: addressFromNumber(200),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(secondRes.status).toBe(201);
    const second = await readJson<IntentJson>(secondRes);

    const firstGet = await readJson<IntentJson>(
      await app.request(`/intents/${first.id}`, { headers: initiatorHeaders }),
    );
    const secondGet = await readJson<IntentJson>(
      await app.request(`/intents/${second.id}`, { headers: initiatorHeaders }),
    );

    expect(firstGet.events?.map((e) => e.type)).toEqual([
      AuditEventType.IntentCreated,
      AuditEventType.IntentApproved,
    ]);
    expect(firstGet.events?.every((e) => e.payload.intentId === first.id)).toBe(true);
    expect(secondGet.events?.map((e) => e.type)).toEqual([AuditEventType.IntentCreated]);
    expect(secondGet.events?.every((e) => e.payload.intentId === second.id)).toBe(true);
  });

  it("allows approver and admin to GET an intent", async () => {
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
    const created = await readJson<IntentJson>(intentRes);

    const asApprover = await app.request(`/intents/${created.id}`, { headers: approverHeaders });
    expect(asApprover.status).toBe(200);
    const asAdmin = await app.request(`/intents/${created.id}`, { headers: adminHeaders });
    expect(asAdmin.status).toBe(200);
  });

  it("returns 404 when an initiator GETs another initiator's intent", async () => {
    const intent = createIntent(openDb(), {
      id: randomUUID(),
      fromWalletId: randomUUID(),
      to: addressFromNumber(200),
      value: 10n ** 15n,
      asset: Asset.Eth,
      initiatorId: "other-initiator",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    });

    const res = await app.request(`/intents/${intent.id}`, {
      headers: { Authorization: "Bearer dev-initiator" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ApiErrorCode.NotFound });
  });

  it("returns 404 for a missing intent", async () => {
    const res = await app.request(`/intents/${randomUUID()}`, { headers: initiatorHeaders });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ApiErrorCode.NotFound });
  });
});
