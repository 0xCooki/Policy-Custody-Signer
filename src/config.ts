import "dotenv/config";

import type { SignerBackend } from "src/signers/types.js";

function env(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: env("DATABASE_PATH", "./data/custody.db"),
  signerBackend: env("SIGNER_BACKEND", "local") as SignerBackend,
  apiKeys: {
    initiator: env("API_KEY_INITIATOR", "dev-initiator"),
    approver: env("API_KEY_APPROVER", "dev-approver"),
    admin: env("API_KEY_ADMIN", "dev-admin"),
  },
} as const;
