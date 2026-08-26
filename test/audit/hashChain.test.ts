import { hashAuditBody } from "src/audit/hash.js";
import { appendAuditEvent } from "src/audit/log.js";
import { verifyAuditChain } from "src/audit/verify.js";
import { listAuditEvents } from "src/db/audit.js";
import { openDb } from "src/db/client.js";
import { AuditEventType } from "src/domain/types.js";
import { describe, expect, it } from "vitest";

const db = openDb(`./data/test-audit-${Date.now()}.db`);

describe("Hash Chain", () => {
  it("appendAuditEvent appends events correctly", () => {
    appendAuditEvent(db, {
      type: AuditEventType.IntentCreated,
      payload: { intentId: "1" },
      actor: "dev-initiator",
    });
    appendAuditEvent(db, {
      type: AuditEventType.IntentApproved,
      payload: { intentId: "1" },
      actor: "dev-approver",
    });
    appendAuditEvent(db, {
      type: AuditEventType.TxConfirmed,
      payload: { intentId: "1" },
      actor: "dev-approver",
    });

    const events = listAuditEvents(db);

    expect(events).toHaveLength(3);
    expect(events[0]?.prevHash).toBe(null);
    expect(events[1]?.prevHash).toBe(events[0]?.eventHash);
    expect(events[2]?.prevHash).toBe(events[1]?.eventHash);
    expect(verifyAuditChain(events)).toBe(true);
  });

  it("tampered payloads fail verifyAuditChain", () => {
    const events = listAuditEvents(db);
    const tampered = events.map((e, i) => {
      return i === 1 ? { ...e, payload: { intentId: "Hacked" } } : e;
    });

    expect(verifyAuditChain(tampered)).toBe(false);
  });

  it("accepts an empty chain and rejects a broken prevHash", () => {
    expect(verifyAuditChain([])).toBe(true);

    const events = listAuditEvents(db);
    const withBreak = events.map((e, i) => (i === 1 ? { ...e, prevHash: null } : e));
    expect(verifyAuditChain(withBreak)).toBe(false);
  });

  it("hashes the same audit body deterministically", () => {
    const body = {
      id: "1",
      type: AuditEventType.IntentCreated,
      payload: { intentId: "1" },
      actor: "dev-initiator",
      timestamp: "2026-01-01T00:00:00.000Z",
      prevHash: null,
    };
    expect(hashAuditBody(body)).toBe(hashAuditBody(body));
    expect(hashAuditBody({ ...body, actor: "other" })).not.toBe(hashAuditBody(body));
  });
});
