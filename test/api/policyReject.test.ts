import { app } from "src/api/index.js";
import { listAuditEvents } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import { AuditEventType, PolicyReason } from "src/domain/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { readJson, type WalletJson } from "test/helpers/json.js";
import { describe, expect, it } from "vitest";

const adminHeaders = { Authorization: "Bearer dev-admin" };
const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};

async function createWalletId(): Promise<string> {
  const walletRes = await app.request("/wallets", { method: "POST", headers: adminHeaders });
  expect(walletRes.status).toBe(201);
  const wallet = await readJson<WalletJson>(walletRes);
  return wallet.id;
}

describe("Policy rejection at API", () => {
  it("rejects over-max value with 422 and PolicyRejected audit", async () => {
    const fromWalletId = await createWalletId();
    const res = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId,
        to: addressFromNumber(200),
        value: (10n ** 18n + 1n).toString(),
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: PolicyReason.ValueOverMax });

    const events = listAuditEvents(openDb());
    expect(events.some((e) => e.type === AuditEventType.PolicyRejected)).toBe(true);
  });

  it("rejects non-allowlisted recipient with 422 and PolicyRejected audit", async () => {
    const fromWalletId = await createWalletId();
    const res = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId,
        to: addressFromNumber(201),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: PolicyReason.ToNotAllowed });

    const events = listAuditEvents(openDb());
    const rejected = events.filter((e) => e.type === AuditEventType.PolicyRejected);
    expect(rejected.some((e) => e.payload.reason === PolicyReason.ToNotAllowed)).toBe(true);
  });
});
