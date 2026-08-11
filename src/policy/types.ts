import type { PolicyReason } from "src/domain/types.js";
import type { Address } from "src/signers/types.js";

export type PolicyConfig = {
  maxValue: bigint;
  allowlist: Address[];
  quorum: number;
};

export type PolicyResult = { ok: true } | { ok: false; reason: PolicyReason };

export type ApproveResult = { ok: true; quorumMet: boolean } | { ok: false; reason: PolicyReason };
