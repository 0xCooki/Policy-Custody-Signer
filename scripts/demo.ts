import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "src/config.js";
import { IntentStatus } from "src/domain/types.js";
import type { Address, Hex } from "src/signers/types.js";
import { arrayFromCsv } from "src/utils/string.js";
import { createWalletClient, http, parseEther, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const ANVIL_ACCOUNT0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const HEALTH_ATTEMPTS = 30;
const HEALTH_RETRY_MS = 2000;

export type DemoKeys = {
  admin: string;
  initiator: string;
  approver: string;
};

export type DemoOpts = {
  baseUrl?: string;
  fetch?: typeof fetch;
  keys?: DemoKeys;
  to?: string;
  value?: string;
  log?: (message: string) => void;
  fund?: (address: string) => Promise<void>;
  healthAttempts?: number;
  healthRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type DemoResult = {
  walletId: string;
  address: string;
  intentId: string;
  status: string;
  txHash: string;
  verified: boolean;
  auditHead: string | null;
};

type WalletBody = { id: string; address: string };
type IntentBody = { id: string; status: string; txHash?: string };
type ExecuteBody = { intent: IntentBody; txHash: string };
type AuditEventBody = { eventHash: string };
type AuditBody = { events: AuditEventBody[]; verified: boolean };

function firstKey(csv: string, role: string): string {
  const key = arrayFromCsv(csv)[0];
  if (!key) throw new Error(`No ${role} API key configured`);
  return key;
}

function defaultKeys(): DemoKeys {
  return {
    admin: firstKey(config.apiKeys.admins, "admin"),
    initiator: firstKey(config.apiKeys.initiators, "initiator"),
    approver: firstKey(config.apiKeys.approvers, "approver"),
  };
}

function defaultTo(): string {
  const to = config.policy.allowlist[0];
  if (!to) throw new Error("POLICY_ALLOWLIST is empty; set a destination or pass opts.to");
  return to;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

async function requestJson<T>(
  fetchFn: typeof fetch,
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetchFn(new URL(path, baseUrl).href, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200);
    throw new Error(
      `${init.method ?? "GET"} ${path} ${res.status}: non-JSON response${snippet ? `: ${snippet}` : ""}`,
    );
  }
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function bearer(key: string, json = false): Record<string, string> {
  return json
    ? { Authorization: `Bearer ${key}`, "content-type": "application/json" }
    : { Authorization: `Bearer ${key}` };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(
  fetchFn: typeof fetch,
  baseUrl: string,
  opts: {
    attempts: number;
    retryMs: number;
    sleep: (ms: number) => Promise<void>;
    log: (message: string) => void;
  },
): Promise<void> {
  let lastError: unknown;
  for (let i = 1; i <= opts.attempts; i++) {
    try {
      await requestJson(fetchFn, baseUrl, "/health", { method: "GET" });
      return;
    } catch (err) {
      lastError = err;
      if (i === opts.attempts) break;
      opts.log(`waiting for /health (${i}/${opts.attempts})`);
      await opts.sleep(opts.retryMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fundSignerFromAnvil(address: string, rpcUrl = config.rpcUrl): Promise<void> {
  const account = privateKeyToAccount(ANVIL_ACCOUNT0_KEY);
  if (account.address.toLowerCase() === address.toLowerCase()) return;

  const client = createWalletClient({
    account,
    chain: foundry,
    transport: http(rpcUrl),
  }).extend(publicActions);

  const hash = await client.sendTransaction({
    to: address as Address,
    value: parseEther("1"),
  });
  await client.waitForTransactionReceipt({ hash });
}

export async function runDemo(opts: DemoOpts = {}): Promise<DemoResult> {
  const fetchFn = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${config.port}`;
  const keys = opts.keys ?? defaultKeys();
  const to = opts.to ?? defaultTo();
  const value = opts.value ?? (10n ** 15n).toString();
  const log = opts.log ?? console.log;

  await waitForHealth(fetchFn, baseUrl, {
    attempts: opts.healthAttempts ?? HEALTH_ATTEMPTS,
    retryMs: opts.healthRetryMs ?? HEALTH_RETRY_MS,
    sleep: opts.sleep ?? defaultSleep,
    log,
  });

  const wallet = await requestJson<WalletBody>(fetchFn, baseUrl, "/wallets", {
    method: "POST",
    headers: bearer(keys.admin),
  });
  await (opts.fund ?? fundSignerFromAnvil)(wallet.address);

  const intent = await requestJson<IntentBody>(fetchFn, baseUrl, "/intents", {
    method: "POST",
    headers: bearer(keys.initiator, true),
    body: JSON.stringify({ fromWalletId: wallet.id, to, value }),
  });

  await requestJson(fetchFn, baseUrl, `/intents/${intent.id}/approve`, {
    method: "POST",
    headers: bearer(keys.approver),
  });

  const executed = await requestJson<ExecuteBody>(
    fetchFn,
    baseUrl,
    `/intents/${intent.id}/execute`,
    {
      method: "POST",
      headers: bearer(keys.admin),
    },
  );

  const audit = await requestJson<AuditBody>(fetchFn, baseUrl, "/audit", {
    method: "GET",
    headers: bearer(keys.admin),
  });

  if (!audit.verified) {
    throw new Error("audit chain verification failed");
  }
  if (executed.intent.status !== IntentStatus.Confirmed) {
    throw new Error(
      `intent status is ${executed.intent.status}, expected ${IntentStatus.Confirmed}`,
    );
  }
  if (!TX_HASH_RE.test(executed.txHash)) {
    throw new Error(`invalid txHash: ${executed.txHash}`);
  }

  const auditHead = audit.events.at(-1)?.eventHash ?? null;
  const result: DemoResult = {
    walletId: wallet.id,
    address: wallet.address,
    intentId: executed.intent.id,
    status: executed.intent.status,
    txHash: executed.txHash,
    verified: audit.verified,
    auditHead,
  };

  log(`verified: ${result.verified}`);
  log(`auditHead: ${result.auditHead ?? "(empty)"}`);
  log(`intent: ${result.status}`);
  log(`txHash: ${result.txHash}`);
  return result;
}

/** True when this module is the process entry (tsx/pnpm pass a relative or absolute argv[1]). */
export function isCliEntry(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return fileURLToPath(metaUrl) === path.resolve(argv1);
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  runDemo().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
