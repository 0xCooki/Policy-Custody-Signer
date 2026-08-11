import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "src/audit/log.js";
import { createApproval, listApprovalsForIntent } from "src/db/approvals.js";
import type { Db } from "src/db/client.js";
import { getIntent, updateIntentStatus } from "src/db/intents.js";
import type { Approval, TransferIntent } from "src/domain/types.js";
import { ApiErrorCode, AuditEventType, IntentStatus } from "src/domain/types.js";
import { evaluateApprove } from "src/policy/engine.js";
import type { PolicyConfig } from "src/policy/types.js";
import { AppError } from "src/utils/errors.js";

export function approveIntent(
  db: Db,
  policy: PolicyConfig,
  input: { intentId: string; approverId: string },
): { intent: TransferIntent; approval: Approval; quorumMet: boolean } {
  const write = db.transaction(() => {
    const intent = getIntent(db, input.intentId);
    if (!intent) throw new AppError(ApiErrorCode.NotFound, `Intent not found: ${input.intentId}`);
    if (intent.status !== IntentStatus.Pending) {
      throw new AppError(
        ApiErrorCode.InvalidStatus,
        `Intent ${input.intentId} is ${intent.status}, expected ${IntentStatus.Pending}`,
      );
    }

    const existing = listApprovalsForIntent(db, intent.id);
    const decision = evaluateApprove(
      {
        initiatorId: intent.initiatorId,
        approverId: input.approverId,
        existingApproverIds: existing.map((a) => a.approverId),
      },
      policy,
    );
    if (!decision.ok) throw new AppError(decision.reason);

    const approval = createApproval(db, {
      id: randomUUID(),
      intentId: intent.id,
      approverId: input.approverId,
      createdAt: new Date().toISOString(),
    });
    appendAuditEvent(db, {
      type: AuditEventType.IntentApproved,
      payload: {
        intentId: intent.id,
        approverId: input.approverId,
        quorumMet: decision.quorumMet,
      },
      actor: input.approverId,
    });
    if (decision.quorumMet) {
      updateIntentStatus(db, intent.id, IntentStatus.Approved);
    }

    const updated = getIntent(db, intent.id);
    if (!updated)
      throw new AppError(ApiErrorCode.NotFound, `Intent missing after update: ${intent.id}`);
    return { intent: updated, approval, quorumMet: decision.quorumMet };
  });

  return write();
}
