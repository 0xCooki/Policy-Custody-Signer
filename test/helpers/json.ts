import type { Address } from "src/signers/types.js";
import { padHex, toHex } from "viem";

export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function addressFromNumber(n: number | bigint): Address {
  return padHex(toHex(n), { size: 20 });
}

export type WalletJson = { id: string; address: string };
export type IntentAuditEventJson = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
};
export type AuditEventJson = IntentAuditEventJson & {
  role: string | null;
  prevHash: string | null;
  eventHash: string;
};
export type IntentJson = {
  id: string;
  status: string;
  txHash?: string;
  events?: IntentAuditEventJson[];
};
export type ApproveJson = { intent: IntentJson; quorumMet: boolean };
export type ExecuteJson = { intent: IntentJson; txHash: string };
export type ReconcileJson = { intent: IntentJson; txHash?: string };
export type AuditJson = { events: AuditEventJson[]; verified: boolean };
