import { randomUUID } from "node:crypto";
import { hashAuditBody } from "src/audit/hash.js";
import { createAuditEvent, getLastAuditEvent } from "src/db/audit.js";
import type { Db } from "src/db/client.js";
import type { AuditEvent, AuditEventType } from "src/domain/types.js";

export function appendAuditEvent(
  db: Db,
  input: { type: AuditEventType; payload: Record<string, unknown>; actor: string },
): AuditEvent {
  const write = db.transaction(() => {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const prevHash = getLastAuditEvent(db)?.eventHash ?? null;
    const eventHash = hashAuditBody({
      id: id,
      type: input.type,
      payload: input.payload,
      actor: input.actor,
      timestamp: timestamp,
      prevHash: prevHash,
    });
    return createAuditEvent(db, {
      id: id,
      type: input.type,
      payload: input.payload,
      actor: input.actor,
      timestamp: timestamp,
      prevHash: prevHash,
      eventHash: eventHash,
    });
  });
  return write();
}
