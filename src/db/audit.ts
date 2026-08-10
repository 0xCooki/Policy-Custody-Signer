import type { Db } from "src/db/client.js";
import type { AuditEvent, AuditEventType } from "src/domain/types.js";
import type { Hex } from "src/signers/types.js";

type AuditEventRow = {
  id: string;
  type: string;
  payload: string;
  actor: string;
  timestamp: string;
  prev_hash: string | null;
  event_hash: string;
};

function rowToAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    type: row.type as AuditEventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    actor: row.actor,
    timestamp: row.timestamp,
    prevHash: (row.prev_hash as Hex | null) ?? null,
    eventHash: row.event_hash as Hex,
  };
}

export function createAuditEvent(
  db: Db,
  input: {
    id: string;
    type: AuditEventType;
    payload: Record<string, unknown>;
    actor: string;
    timestamp: string;
    prevHash: Hex | null;
    eventHash: Hex;
  },
): AuditEvent {
  db.prepare(
    `INSERT INTO audit_events (id, type, payload, actor, timestamp, prev_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.type,
    JSON.stringify(input.payload),
    input.actor,
    input.timestamp,
    input.prevHash,
    input.eventHash,
  );

  return { ...input };
}

export function listAuditEvents(db: Db): AuditEvent[] {
  const rows = db
    .prepare(
      `SELECT id, type, payload, actor, timestamp, prev_hash, event_hash FROM audit_events ORDER BY rowid ASC`,
    )
    .all() as AuditEventRow[];

  return rows.map(rowToAuditEvent);
}

export function getLastAuditEvent(db: Db): AuditEvent | undefined {
  const row = db
    .prepare(
      `SELECT id, type, payload, actor, timestamp, prev_hash, event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as AuditEventRow | undefined;

  return row ? rowToAuditEvent(row) : undefined;
}
