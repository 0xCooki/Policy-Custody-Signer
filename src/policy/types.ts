import type { Address } from "src/signers/types.js";

export type PolicyConfig = {
  maxValue: bigint;
  allowlist: Address[];
  quorum: number;
};

export type PolicyResult = { ok: true } | { ok: false; reason: string };

export type ApproveResult = { ok: true; quorumMet: boolean } | { ok: false; reason: string };
