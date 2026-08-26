import type { Hono } from "hono";
import { createMockMpcApp } from "src/mockMpc/api.js";
import { CeremonyStore, MOCK_MPC_DEV_KEY } from "src/mockMpc/ceremonies.js";
import { CeremonyError } from "src/mockMpc/types.js";
import { MockMpcSigner } from "src/signers/mockMpc.js";
import { CeremonyStatus, fingerprintTx } from "src/signers/mockMpcProtocol.js";
import { type Hex, SignerBackend, type UnsignedTx } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

const sampleTx: UnsignedTx = {
  to: addressFromNumber(100),
  value: 10n ** 15n,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 10n ** 9n,
  maxPriorityFeePerGas: 10n ** 9n,
  chainId: 31337,
};

const signed = "0xsigned" as Hex;
const account = privateKeyToAccount(MOCK_MPC_DEV_KEY);

function honoFetch(app: Hono): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return app.request(new URL(url, "http://mock-mpc.local").pathname, init);
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signerFromFetch(
  fetchFn: typeof fetch,
  extra?: Partial<ConstructorParameters<typeof MockMpcSigner>[0]>,
) {
  return new MockMpcSigner({
    baseUrl: "http://mock-mpc.local",
    apiKey: "dev-mpc-secret",
    pollIntervalMs: 50,
    timeoutMs: 100,
    sleep: async () => {},
    fetch: fetchFn,
    ...extra,
  });
}

describe("MockMpcSigner", () => {
  it("rejects a non-positive poll interval or timeout", () => {
    expect(() => signerFromFetch(async () => jsonResponse(200, {}), { pollIntervalMs: 0 })).toThrow(
      /pollIntervalMs/,
    );
    expect(() => signerFromFetch(async () => jsonResponse(200, {}), { timeoutMs: -1 })).toThrow(
      /timeoutMs/,
    );
  });

  it("has the mock-mpc backend name", () => {
    expect(signerFromFetch(async () => jsonResponse(200, {})).name).toBe(SignerBackend.MockMpc);
  });

  it("reads the wallet address from the vendor", async () => {
    const signer = signerFromFetch(async () => jsonResponse(200, { address: account.address }));
    expect(await signer.getAddress()).toBe(account.address);
  });

  it("returns a completed signature without polling", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const path = new URL(String(input), "http://mock-mpc.local").pathname;
      if (path === "/v1/signing-requests") {
        return jsonResponse(202, {
          requestId: "req-1",
          status: CeremonyStatus.Completed,
          signedTransaction: signed,
        });
      }
      throw new Error(`unexpected poll of ${path}`);
    };
    const signer = signerFromFetch(fetchFn);
    expect(await signer.signTransaction(sampleTx)).toBe(signed);
  });

  it("polls until the vendor completes", async () => {
    let polls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      polls += 1;
      if (polls === 1) {
        return jsonResponse(200, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      return jsonResponse(200, {
        requestId: "req-1",
        status: CeremonyStatus.Completed,
        signedTransaction: signed,
      });
    };
    const signer = signerFromFetch(fetchFn);
    expect(await signer.signTransaction(sampleTx)).toBe(signed);
    expect(polls).toBe(2);
  });

  it("throws on terminal vendor failure", async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse(202, {
        requestId: "req-1",
        status: CeremonyStatus.Failed,
        error: CeremonyError.ThresholdNotMet,
      });
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(
      CeremonyError.ThresholdNotMet,
    );
  });

  it("times out while the request stays pending", async () => {
    let t = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      return jsonResponse(200, { requestId: "req-1", status: CeremonyStatus.Pending });
    };
    await expect(
      signerFromFetch(fetchFn, {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }).signTransaction(sampleTx),
    ).rejects.toThrow(/timed out/);
  });

  it("aborts a hung vendor request", async () => {
    const fetchFn = () => new Promise<Response>(() => {});
    await expect(
      signerFromFetch(fetchFn as typeof fetch, { timeoutMs: 30 }).getAddress(),
    ).rejects.toThrow(/timed out/);
  });

  it("retries a transient poll failure then completes", async () => {
    let polls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      polls += 1;
      if (polls === 1) throw new Error("network down");
      return jsonResponse(200, {
        requestId: "req-1",
        status: CeremonyStatus.Completed,
        signedTransaction: signed,
      });
    };
    expect(await signerFromFetch(fetchFn).signTransaction(sampleTx)).toBe(signed);
  });

  it("does not retry a 404 while polling", async () => {
    let polls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      polls += 1;
      return jsonResponse(404, { error: CeremonyError.NotFound });
    };
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(
      CeremonyError.NotFound,
    );
    expect(polls).toBe(1);
  });

  it("does not swallow unexpected errors while polling", async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      const res = jsonResponse(200, {});
      return Object.assign(res, {
        json: async () => ({
          get status(): string {
            throw new TypeError("bad status");
          },
        }),
      });
    };
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(/bad status/);
  });

  it("throws on a malformed completed response", async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Completed });
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(/malformed/);
  });

  it("throws on unauthorized wallet lookup", async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse(401, { error: CeremonyError.Unauthorized });
    await expect(signerFromFetch(fetchFn).getAddress()).rejects.toThrow(CeremonyError.Unauthorized);
  });

  it("signs through the importable vendor app", async () => {
    const store = new CeremonyStore({ privateKey: MOCK_MPC_DEV_KEY });
    const app = createMockMpcApp({
      apiKey: "dev-mpc-secret",
      chainId: 31337,
      address: account.address,
      store,
    });
    const signer = signerFromFetch(honoFetch(app));
    expect(await signer.getAddress()).toBe(account.address);
    const hex = await signer.signTransaction(sampleTx);
    expect(isHex(hex)).toBe(true);
    expect(hex.length).toBeGreaterThan(2);
  });

  it("uses a fee-stable fingerprint as the default idempotency key", async () => {
    const keys: string[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        const headers = new Headers(init.headers);
        keys.push(headers.get("idempotency-key") ?? "");
        return jsonResponse(202, {
          requestId: "req-1",
          status: CeremonyStatus.Completed,
          signedTransaction: signed,
        });
      }
      throw new Error("unexpected poll");
    };
    const signer = signerFromFetch(fetchFn);
    await signer.signTransaction(sampleTx);
    await signer.signTransaction({ ...sampleTx, gas: 22000n, maxFeePerGas: 99n });
    expect(keys).toEqual([fingerprintTx(sampleTx), fingerprintTx(sampleTx)]);
  });

  it("prefers a per-call idempotency key over the fingerprint", async () => {
    const keys: string[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        const headers = new Headers(init.headers);
        keys.push(headers.get("idempotency-key") ?? "");
        return jsonResponse(202, {
          requestId: "req-1",
          status: CeremonyStatus.Completed,
          signedTransaction: signed,
        });
      }
      throw new Error("unexpected poll");
    };
    const signer = signerFromFetch(fetchFn);
    await signer.signTransaction(sampleTx, { idempotencyKey: "intent-1" });
    expect(keys).toEqual(["intent-1"]);
  });

  it("reuses one idempotency key for a single signTransaction call", async () => {
    const keys: string[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        const headers = new Headers(init.headers);
        keys.push(headers.get("idempotency-key") ?? "");
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Completed });
      }
      return jsonResponse(200, {
        requestId: "req-1",
        status: CeremonyStatus.Completed,
        signedTransaction: signed,
      });
    };
    const signer = signerFromFetch(fetchFn, { idempotencyKey: () => "fixed-key" });
    await signer.signTransaction(sampleTx);
    expect(keys).toEqual(["fixed-key"]);
  });

  it("throws on a malformed wallet address", async () => {
    const signer = signerFromFetch(async () => jsonResponse(200, { address: "not-an-address" }));
    await expect(signer.getAddress()).rejects.toThrow(/malformed/);
  });

  it("throws when a completed create has no requestId", async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse(202, { status: CeremonyStatus.Completed });
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(/malformed/);
  });

  it("throws when a poll completes without a signed hex", async () => {
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      return jsonResponse(200, { requestId: "req-1", status: CeremonyStatus.Completed });
    };
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(/malformed/);
  });

  it("retries a 5xx poll then completes", async () => {
    let polls = 0;
    const fetchFn: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        return jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Pending });
      }
      polls += 1;
      if (polls === 1) return jsonResponse(503, { error: "busy" });
      return jsonResponse(200, {
        requestId: "req-1",
        status: CeremonyStatus.Completed,
        signedTransaction: signed,
      });
    };
    expect(await signerFromFetch(fetchFn).signTransaction(sampleTx)).toBe(signed);
    expect(polls).toBe(2);
  });

  it("uses signing failed when the vendor omits an error", async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse(202, { requestId: "req-1", status: CeremonyStatus.Failed });
    await expect(signerFromFetch(fetchFn).signTransaction(sampleTx)).rejects.toThrow(
      /signing failed/,
    );
  });

  it("strips a trailing slash from the base URL", async () => {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(200, { address: account.address });
    };
    const signer = signerFromFetch(fetchFn, { baseUrl: "http://mock-mpc.local/" });
    await signer.getAddress();
    expect(urls).toEqual(["http://mock-mpc.local/v1/wallet"]);
  });
});
