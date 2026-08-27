import path from "node:path";
import { pathToFileURL } from "node:url";
import { isCliEntry, runDemo } from "scripts/demo.js";
import { AuditEventType, IntentStatus } from "src/domain/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it } from "vitest";

const to = addressFromNumber(200);
const value = (10n ** 15n).toString();
const keys = { admin: "dev-admin", initiator: "dev-initiator", approver: "dev-approver" };
const txHash = `0x${"ab".repeat(32)}`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authFrom(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined;
  return (headers as Record<string, string>).Authorization;
}

type RecordedCall = { method: string; path: string; authorization?: string };

function demoFetch(opts?: {
  calls?: RecordedCall[];
  execute?: unknown;
  audit?: unknown;
}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    opts?.calls?.push({ method, path: url.pathname, authorization: authFrom(init) });

    if (method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, { ok: true, signerBackend: "local" });
    }
    if (method === "POST" && url.pathname === "/wallets") {
      return jsonResponse(201, { id: "wallet-1", address: "0xabc" });
    }
    if (method === "POST" && url.pathname === "/intents") {
      const body = JSON.parse(String(init?.body)) as {
        fromWalletId: string;
        to: string;
        value: string;
      };
      expect(body.fromWalletId).toBe("wallet-1");
      expect(body.to).toBe(to);
      expect(body.value).toBe(value);
      return jsonResponse(201, { id: "intent-1", status: IntentStatus.Pending });
    }
    if (method === "POST" && url.pathname === "/intents/intent-1/approve") {
      return jsonResponse(200, {
        intent: { id: "intent-1", status: IntentStatus.Approved },
        quorumMet: true,
      });
    }
    if (method === "POST" && url.pathname === "/intents/intent-1/execute") {
      return jsonResponse(
        200,
        opts?.execute ?? {
          intent: { id: "intent-1", status: IntentStatus.Confirmed, txHash },
          txHash,
        },
      );
    }
    if (method === "GET" && url.pathname === "/audit") {
      return jsonResponse(
        200,
        opts?.audit ?? {
          verified: true,
          events: [
            { type: AuditEventType.IntentCreated, eventHash: "0xaaa" },
            { type: AuditEventType.TxConfirmed, eventHash: "0xhead" },
          ],
        },
      );
    }
    return jsonResponse(404, { error: "not_found" });
  };
}

describe("runDemo", () => {
  it("walks health → wallet → intent → approve → execute → audit", async () => {
    const calls: RecordedCall[] = [];
    const logs: string[] = [];
    const fundCalls: string[] = [];

    const result = await runDemo({
      baseUrl: "http://demo.local",
      fetch: demoFetch({ calls }),
      keys,
      to,
      fund: async (address) => {
        fundCalls.push(address);
      },
      log: (message) => logs.push(message),
    });

    expect(calls).toEqual([
      { method: "GET", path: "/health", authorization: undefined },
      { method: "POST", path: "/wallets", authorization: "Bearer dev-admin" },
      { method: "POST", path: "/intents", authorization: "Bearer dev-initiator" },
      { method: "POST", path: "/intents/intent-1/approve", authorization: "Bearer dev-approver" },
      { method: "POST", path: "/intents/intent-1/execute", authorization: "Bearer dev-admin" },
      { method: "GET", path: "/audit", authorization: "Bearer dev-admin" },
    ]);
    expect(fundCalls).toEqual(["0xabc"]);
    expect(result).toEqual({
      walletId: "wallet-1",
      address: "0xabc",
      intentId: "intent-1",
      status: IntentStatus.Confirmed,
      txHash,
      verified: true,
      auditHead: "0xhead",
    });
    expect(logs).toEqual([
      "verified: true",
      "auditHead: 0xhead",
      "intent: confirmed",
      `txHash: ${txHash}`,
    ]);
  });

  it("retries /health until the API is up", async () => {
    let healthCalls = 0;
    const sleeps: number[] = [];
    const logs: string[] = [];
    const inner = demoFetch();
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && url.pathname === "/health") {
        healthCalls += 1;
        if (healthCalls < 3) {
          return jsonResponse(502, { error: "bad_gateway" });
        }
      }
      return inner(input, init);
    };

    await runDemo({
      baseUrl: "http://demo.local",
      fetch: fetchFn,
      keys,
      to,
      fund: async () => {},
      log: (message) => logs.push(message),
      healthAttempts: 5,
      healthRetryMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(healthCalls).toBe(3);
    expect(sleeps).toEqual([25, 25]);
    expect(logs.slice(0, 2)).toEqual(["waiting for /health (1/5)", "waiting for /health (2/5)"]);
  });

  it("throws after /health retries are exhausted", async () => {
    const sleeps: number[] = [];
    const fetchFn: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      runDemo({
        baseUrl: "http://demo.local",
        fetch: fetchFn,
        keys,
        to,
        fund: async () => {},
        log: () => {},
        healthAttempts: 3,
        healthRetryMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(sleeps).toEqual([10, 10]);
  });

  it("throws when a step returns a non-OK status", async () => {
    const fetchFn: typeof fetch = async () => jsonResponse(401, { error: "unauthorized" });
    await expect(
      runDemo({
        baseUrl: "http://demo.local",
        fetch: fetchFn,
        keys,
        to,
        fund: async () => {},
        log: () => {},
        healthAttempts: 1,
      }),
    ).rejects.toThrow(/GET \/health 401/);
  });

  it("throws when a step returns a non-JSON body", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    await expect(
      runDemo({
        baseUrl: "http://demo.local",
        fetch: fetchFn,
        keys,
        to,
        fund: async () => {},
        log: () => {},
        healthAttempts: 1,
      }),
    ).rejects.toThrow(/GET \/health 502: non-JSON response: <html>bad gateway<\/html>/);
  });

  it("throws when the audit chain is not verified", async () => {
    await expect(
      runDemo({
        baseUrl: "http://demo.local",
        fetch: demoFetch({
          audit: { verified: false, events: [{ eventHash: "0xaaa" }] },
        }),
        keys,
        to,
        fund: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/audit chain verification failed/);
  });

  it("throws when execute does not confirm the intent", async () => {
    await expect(
      runDemo({
        baseUrl: "http://demo.local",
        fetch: demoFetch({
          execute: {
            intent: { id: "intent-1", status: IntentStatus.Failed, txHash },
            txHash,
          },
        }),
        keys,
        to,
        fund: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/intent status is failed, expected confirmed/);
  });

  it("throws when txHash is not a 32-byte hash", async () => {
    await expect(
      runDemo({
        baseUrl: "http://demo.local",
        fetch: demoFetch({
          execute: {
            intent: { id: "intent-1", status: IntentStatus.Confirmed, txHash: "0xabc123" },
            txHash: "0xabc123",
          },
        }),
        keys,
        to,
        fund: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/invalid txHash/);
  });
});

describe("isCliEntry", () => {
  const metaUrl = pathToFileURL(path.resolve("scripts/demo.ts")).href;

  it("matches relative and absolute argv[1] to import.meta.url", () => {
    expect(isCliEntry(metaUrl, "scripts/demo.ts")).toBe(true);
    expect(isCliEntry(metaUrl, path.resolve("scripts/demo.ts"))).toBe(true);
  });

  it("is false when argv[1] is missing or is another path", () => {
    expect(isCliEntry(metaUrl, undefined)).toBe(false);
    expect(isCliEntry(metaUrl, "tsx")).toBe(false);
  });
});
