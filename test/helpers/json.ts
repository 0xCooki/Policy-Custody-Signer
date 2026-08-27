/** Typed JSON body helper — Hono's `Response.json()` is typed as `unknown`. */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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
export type AuditJson = { events: AuditEventJson[]; verified: boolean };
