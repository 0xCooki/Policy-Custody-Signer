import type { Hex } from "src/signers/types.js";
import { canonicalJson } from "src/utils/json.js";
import { keccak256, toBytes } from "viem";

export function hashAuditBody(body: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  actor: string;
  timestamp: string;
  prevHash: Hex | null;
}): Hex {
  const encoded = canonicalJson({
    id: body.id,
    type: body.type,
    payload: body.payload,
    actor: body.actor,
    timestamp: body.timestamp,
    prevHash: body.prevHash,
  });
  return keccak256(toBytes(encoded));
}
