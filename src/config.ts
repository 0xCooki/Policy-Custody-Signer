import "dotenv/config";

import type { SignerBackend } from "src/signers/types.js";

function envString(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return Number(raw);
}

export const config = {
  port: envInt("PORT", 3000),
  databasePath: envString("DATABASE_PATH", "./data/custody.db"),
  signerBackend: envString("SIGNER_BACKEND", "local") as SignerBackend,
  apiKeys: {
    initiator: envString("API_KEY_INITIATOR", "dev-initiator"),
    approver: envString("API_KEY_APPROVER", "dev-approver"),
    admin: envString("API_KEY_ADMIN", "dev-admin"),
  },
  rpcUrl: envString("RPC_URL", "http://127.0.0.1:8545"),
  chainId: envInt("CHAIN_ID", 31337),
  localPrivateKey: envString("LOCAL_PRIVATE_KEY", ""),
} as const;
