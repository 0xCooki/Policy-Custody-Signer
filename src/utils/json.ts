import { resolveApiKey } from "src/auth/resolveApiKey.js";
import type { ApiKeysConfig } from "src/auth/types.js";
import type { AuditEvent } from "src/domain/types.js";

export function intentToJson(intent: { value: bigint; [k: string]: unknown }) {
  return { ...intent, value: intent.value.toString() };
}

function publicAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "approverId"));
}

export function intentAuditToJson(event: AuditEvent) {
  return {
    id: event.id,
    type: event.type,
    payload: publicAuditPayload(event.payload),
    timestamp: event.timestamp,
  };
}

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
