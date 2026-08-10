import { hashAuditBody } from "src/audit/hash.js";
import type { AuditEvent } from "src/domain/types.js";
import type { Hex } from "src/signers/types.js";

export function verifyAuditChain(events: AuditEvent[]): boolean {
  let expectedPrev: Hex | null = null;

  for (const event of events) {
    if (event.prevHash !== expectedPrev) return false;

    const recomputed = hashAuditBody({
      id: event.id,
      type: event.type,
      payload: event.payload,
      actor: event.actor,
      timestamp: event.timestamp,
      prevHash: event.prevHash,
    });

    if (recomputed !== event.eventHash) return false;
    expectedPrev = recomputed;
  }

  return true;
}
