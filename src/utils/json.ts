import { resolveApiKey } from "src/auth/resolveApiKey.js";
import type { ApiKeysConfig } from "src/auth/types.js";
import type { AuditEvent } from "src/domain/types.js";

export function intentToJson(intent: { value: bigint; [k: string]: unknown }) {
  return { ...intent, value: intent.value.toString() };
}

/** Drop approverId from the public view (hash input still uses the raw payload). */
function publicAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "approverId"));
}

/** Per-intent audit slice: no actor and no chain hashes (not a verifiable chain). */
export function intentAuditToJson(event: AuditEvent) {
  return {
    id: event.id,
    type: event.type,
    payload: publicAuditPayload(event.payload),
    timestamp: event.timestamp,
  };
}

/**
 * Admin GET /audit: keep chain hashes, replace actor with role.
 * `verified` must be computed on the raw events, not this view.
 */
export function auditEventToJson(event: AuditEvent, apiKeys: ApiKeysConfig) {
  return {
    id: event.id,
    type: event.type,
    payload: publicAuditPayload(event.payload),
    role: resolveApiKey(event.actor, apiKeys)?.role ?? null,
    timestamp: event.timestamp,
    prevHash: event.prevHash,
    eventHash: event.eventHash,
  };
}

// Must always build objects with a fixed key order
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
