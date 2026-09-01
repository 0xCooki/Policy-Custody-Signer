import type { Db } from "src/db/client.js";
import type { Approval } from "src/domain/types.js";

type ApprovalRow = {
  id: string;
  intent_id: string;
  approver_id: string;
  created_at: string;
};

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    intentId: row.intent_id,
    approverId: row.approver_id,
    createdAt: row.created_at,
  };
}

export function createApproval(
  db: Db,
  input: { id: string; intentId: string; approverId: string; createdAt: string },
): Approval {
  db.prepare(
    `INSERT INTO approvals (id, intent_id, approver_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(input.id, input.intentId, input.approverId, input.createdAt);
  return { ...input };
}

export function listApprovalsForIntent(db: Db, intentId: string): Approval[] {
  const rows = db
    .prepare(
      `SELECT id, intent_id, approver_id, created_at FROM approvals WHERE intent_id = ? ORDER BY rowid ASC`,
    )
    .all(intentId) as ApprovalRow[];

  return rows.map(rowToApproval);
}
