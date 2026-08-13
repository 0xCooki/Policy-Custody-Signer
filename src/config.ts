import "dotenv/config";

import { SignerBackend } from "src/signers/types.js";
import { arrayFromCsv } from "src/utils/string.js";

function envString(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return n;
}

function envSignerBackend(name: string, fallback: SignerBackend): SignerBackend {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const values = Object.values(SignerBackend) as string[];
  if (!values.includes(raw)) {
    throw new Error(`Invalid ${name}="${raw}". Expected one of: ${values.join(", ")}`);
  }
  return raw as SignerBackend;
}

export const config = {
  port: envInt("PORT", 3000),
  databasePath: envString("DATABASE_PATH", "./data/custody.db"),
  signerBackend: envSignerBackend("SIGNER_BACKEND", SignerBackend.Local),
  softHsm: {
    modulePath: envString("SOFTHSM_MODULE_PATH", ""),
    pin: envString("SOFTHSM_PIN", "1234"),
    slot: envInt("SOFTHSM_SLOT", 0),
    keyLabel: envString("SOFTHSM_KEY_LABEL", "custody-eth"),
  },
  apiKeys: {
    initiators: envString("API_KEY_INITIATORS", "dev-initiator"),
    approvers: envString("API_KEY_APPROVERS", "dev-approver"),
    admins: envString("API_KEY_ADMINS", "dev-admin"),
  },
  rpcUrl: envString("RPC_URL", "http://127.0.0.1:8545"),
  chainId: envInt("CHAIN_ID", 31337),
  localPrivateKey: envString("LOCAL_PRIVATE_KEY", ""),
  policy: {
    maxValue: BigInt(envString("POLICY_MAX_VALUE", `${10n ** 18n}`)),
    allowlist: arrayFromCsv(envString("POLICY_ALLOWLIST", "")),
    quorum: envInt("POLICY_QUORUM", 1),
  },
} as const;
