import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "src/audit/log.js";
import { createApproval, listApprovalsForIntent } from "src/db/approvals.js";
import type { Db } from "src/db/client.js";
import { getIntent, updateIntentStatus } from "src/db/intents.js";
import type { Approval, TransferIntent } from "src/domain/types.js";
import { evaluateApprove } from "src/policy/engine.js";
import type { PolicyConfig } from "src/policy/types.js";

export function approveIntent(
  db: Db,
  policy: PolicyConfig,
  input: { intentId: string; approverId: string },
): { intent: TransferIntent; approval: Approval; quorumMet: boolean } {
  const write = db.transaction(() => {
    // Get intent from the database
    const intent = getIntent(db, input.intentId);
    if (!intent) throw new Error(`Intent not found: ${input.intentId}`);
    if (intent.status !== "pending")
      throw new Error(`Intent ${input.intentId} is ${intent.status}, expected pending`);

    // Get existing approvals and evaluate decision
    const existing = listApprovalsForIntent(db, intent.id);
    const decision = evaluateApprove(
      {
        initiatorId: intent.initiatorId,
        approverId: input.approverId,
        existingApproverIds: existing.map((a) => a.approverId),
      },
      policy,
    );
    if (!decision.ok) throw new Error(decision.reason);

    // Approve the intent
    const approval = createApproval(db, {
      id: randomUUID(),
      intentId: intent.id,
      approverId: input.approverId,
      createdAt: new Date().toISOString(),
    });
    appendAuditEvent(db, {
      type: "IntentApproved",
      payload: {
        intentId: intent.id,
        approverId: input.approverId,
        quorumMet: decision.quorumMet,
      },
      actor: input.approverId,
    });
    if (decision.quorumMet) {
      updateIntentStatus(db, intent.id, "approved");
    }

    const updated = getIntent(db, intent.id);
    if (!updated) throw new Error(`Intent missing after update: ${intent.id}`);
    return { intent: updated, approval, quorumMet: decision.quorumMet };
  });

  return write();
}
