import type { ApproveResult, PolicyConfig, PolicyResult } from "src/policy/types.js";
import type { Address } from "src/signers/types.js";

export function evaluateCreate(
  input: { to: Address; value: bigint },
  policy: PolicyConfig,
): PolicyResult {
  if (input.value > policy.maxValue) {
    return { ok: false, reason: "value_over_max" };
  }

  const allowed = policy.allowlist.some((a) => a.toLowerCase() === input.to.toLowerCase());
  if (!allowed) {
    return { ok: false, reason: "to_not_allowed" };
  }

  return { ok: true };
}

export function evaluateApprove(
  input: {
    initiatorId: string;
    approverId: string;
    existingApproverIds: string[];
  },
  policy: PolicyConfig,
): ApproveResult {
  if (input.approverId === input.initiatorId) {
    return { ok: false, reason: "self_approval" };
  }

  if (input.existingApproverIds.includes(input.approverId)) {
    return { ok: false, reason: "duplicate_approval" };
  }

  const approvalCount = input.existingApproverIds.length + 1;
  return { ok: true, quorumMet: approvalCount >= policy.quorum };
}
