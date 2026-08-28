import { randomUUID } from "node:crypto";
import { app } from "src/api/index.js";
import { listAuditEvents } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import { ApiErrorCode, AuditEventType } from "src/domain/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it } from "vitest";

const initiatorHeaders = {
  Authorization: "Bearer dev-initiator",
  "content-type": "application/json",
};

describe("Intent create", () => {
  it("returns 404 for an unknown fromWalletId and skips policy without audit events", async () => {
    const before = listAuditEvents(openDb());

    const res = await app.request("/intents", {
      method: "POST",
      headers: initiatorHeaders,
      body: JSON.stringify({
        fromWalletId: randomUUID(),
        to: addressFromNumber(201),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: ApiErrorCode.NotFound });

    const added = listAuditEvents(openDb()).slice(before.length);
    expect(added.some((e) => e.type === AuditEventType.IntentCreated)).toBe(false);
    expect(added.some((e) => e.type === AuditEventType.PolicyRejected)).toBe(false);
  });
});
