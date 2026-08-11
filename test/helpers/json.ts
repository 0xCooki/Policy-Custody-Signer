/** Typed JSON body helper — Hono's `Response.json()` is typed as `unknown`. */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export type WalletJson = { id: string; address: string };
export type IntentJson = { id: string; status: string; txHash?: string };
export type ApproveJson = { intent: IntentJson; quorumMet: boolean };
export type ExecuteJson = { intent: IntentJson; txHash: string };
