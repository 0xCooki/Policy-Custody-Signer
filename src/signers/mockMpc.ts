import { CeremonyStatus, fingerprintTx, unsignedTxToJson } from "src/signers/mockMpcProtocol.js";
import {
  type Address,
  type Hex,
  SignerBackend,
  type SignerProvider,
  type SignTransactionOpts,
  type UnsignedTx,
} from "src/signers/types.js";
import { isAddress } from "viem";

export type MockMpcSignerOpts = {
  baseUrl: string;
  apiKey: string;
  pollIntervalMs: number;
  timeoutMs: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  idempotencyKey?: (tx: UnsignedTx) => string;
};

type SigningStatus = {
  requestId?: string;
  status?: string;
  signedTransaction?: Hex;
  error?: string;
};

class VendorError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VendorError";
  }
}

export class MockMpcSigner implements SignerProvider {
  readonly name = SignerBackend.MockMpc;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly nextIdempotencyKey: (tx: UnsignedTx) => string;

  constructor(opts: MockMpcSignerOpts) {
    if (opts.pollIntervalMs <= 0) {
      throw new Error("mock-mpc pollIntervalMs must be a positive integer");
    }
    if (opts.timeoutMs <= 0) {
      throw new Error("mock-mpc timeoutMs must be a positive integer");
    }
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.timeoutMs = opts.timeoutMs;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.nextIdempotencyKey = opts.idempotencyKey ?? fingerprintTx;
  }

  async getAddress(): Promise<Address> {
    const body = await this.requestJson<{ address?: string }>(
      "/v1/wallet",
      undefined,
      this.timeoutMs,
    );
    if (typeof body.address !== "string" || !isAddress(body.address, { strict: false })) {
      throw new VendorError("malformed vendor response", false);
    }
    return body.address;
  }

  async signTransaction(tx: UnsignedTx, opts?: SignTransactionOpts): Promise<Hex> {
    const key = opts?.idempotencyKey ?? this.nextIdempotencyKey(tx);
    const deadline = this.now() + this.timeoutMs;
    const remaining = () => deadline - this.now();

    const created = await this.requestJson<SigningStatus>(
      "/v1/signing-requests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify(unsignedTxToJson(tx)),
      },
      remaining(),
    );

    const signed = this.completedHex(created);
    if (signed) return signed;
    this.throwIfFailed(created);
    if (!created.requestId) throw new VendorError("malformed vendor response", false);

    for (;;) {
      if (remaining() <= 0) throw new Error("mock-mpc signing timed out");
      await this.sleep(Math.min(this.pollIntervalMs, remaining()));
      if (remaining() <= 0) throw new Error("mock-mpc signing timed out");
      try {
        const status = await this.requestJson<SigningStatus>(
          `/v1/signing-requests/${created.requestId}`,
          undefined,
          remaining(),
        );
        const hex = this.completedHex(status);
        if (hex) return hex;
        if (status.status === CeremonyStatus.Completed) {
          throw new VendorError("malformed vendor response", false);
        }
        this.throwIfFailed(status);
      } catch (err) {
        if (!(err instanceof VendorError) || !err.retryable) throw err;
      }
    }
  }

  private completedHex(status: SigningStatus): Hex | undefined {
    if (status.status !== CeremonyStatus.Completed) return undefined;
    if (typeof status.signedTransaction === "string" && status.signedTransaction.startsWith("0x")) {
      return status.signedTransaction;
    }
    return undefined;
  }

  private throwIfFailed(status: SigningStatus): void {
    if (status.status === CeremonyStatus.Failed) {
      throw new VendorError(status.error ?? "signing failed", false);
    }
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<T> {
    if (timeoutMs <= 0) {
      throw new VendorError("vendor request timed out", true);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const res = await new Promise<Response>((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new VendorError("vendor request timed out", true));
        }, timeoutMs);
        void this.fetchFn(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...init?.headers,
          },
        }).then(
          (response) => {
            if (!timedOut) resolve(response);
          },
          (err) => {
            if (!timedOut) reject(err);
          },
        );
      });
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      const body = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) {
        throw new VendorError(body.error ?? `vendor ${res.status}`, res.status >= 500);
      }
      return body;
    } catch (err) {
      if (err instanceof VendorError) throw err;
      throw new VendorError(err instanceof Error ? err.message : "vendor unreachable", true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
