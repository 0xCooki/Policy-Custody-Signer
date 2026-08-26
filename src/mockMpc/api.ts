import { Hono } from "hono";
import { type CeremonyStore, PARTICIPANT_IDS, THRESHOLD } from "src/mockMpc/ceremonies.js";
import {
  CeremonyConflictError,
  CeremonyError,
  CeremonyStatus,
  InvalidRequestError,
  type ParticipantId,
  type UnsignedTxJson,
  unsignedTxFromJson,
} from "src/mockMpc/types.js";
import type { Address, Hex } from "src/signers/types.js";
import { extractApiKey } from "src/utils/string.js";
import { isAddress, isHex } from "viem";

export type MockMpcAppOpts = {
  apiKey: string;
  chainId: number;
  address: Address;
  store: CeremonyStore;
};

function parseDecimalBigInt(raw: unknown, field: string): bigint {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    throw new InvalidRequestError(`invalid ${field}`);
  }
  return BigInt(raw);
}

function parseUnsignedTxJson(body: unknown, chainId: number): UnsignedTxJson {
  if (body === null || typeof body !== "object") {
    throw new InvalidRequestError();
  }
  const o = body as Record<string, unknown>;
  if (typeof o.to !== "string" || !isAddress(o.to, { strict: false })) {
    throw new InvalidRequestError("invalid to");
  }
  if (typeof o.nonce !== "number" || !Number.isInteger(o.nonce) || o.nonce < 0) {
    throw new InvalidRequestError("invalid nonce");
  }
  if (typeof o.chainId !== "number" || o.chainId !== chainId) {
    throw new InvalidRequestError("invalid chainId");
  }
  if (o.data !== undefined && (typeof o.data !== "string" || !isHex(o.data))) {
    throw new InvalidRequestError("invalid data");
  }

  parseDecimalBigInt(o.value, "value");
  parseDecimalBigInt(o.gas, "gas");
  parseDecimalBigInt(o.maxFeePerGas, "maxFeePerGas");
  parseDecimalBigInt(o.maxPriorityFeePerGas, "maxPriorityFeePerGas");

  return {
    to: o.to,
    value: o.value as string,
    ...(typeof o.data === "string" ? { data: o.data as Hex } : {}),
    nonce: o.nonce,
    gas: o.gas as string,
    maxFeePerGas: o.maxFeePerGas as string,
    maxPriorityFeePerGas: o.maxPriorityFeePerGas as string,
    chainId: o.chainId,
  };
}

function parseAvailable(body: unknown): ParticipantId[] {
  if (body === null || typeof body !== "object") {
    throw new InvalidRequestError();
  }
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.available)) {
    throw new InvalidRequestError("invalid available");
  }
  const allowed = new Set<number>(PARTICIPANT_IDS);
  const ids = new Set<ParticipantId>();
  for (const raw of o.available) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || !allowed.has(raw)) {
      throw new InvalidRequestError("invalid available");
    }
    ids.add(raw as ParticipantId);
  }
  return [...ids];
}

function participantsBody(store: CeremonyStore) {
  return {
    threshold: THRESHOLD,
    participants: [...PARTICIPANT_IDS],
    available: store.getAvailable(),
  };
}

function ceremonyToStatus(ceremony: {
  requestId: string;
  status: string;
  signedTransaction?: Hex;
  error?: string;
}) {
  if (ceremony.status === CeremonyStatus.Completed) {
    return {
      requestId: ceremony.requestId,
      status: ceremony.status,
      signedTransaction: ceremony.signedTransaction,
    };
  }
  if (ceremony.status === CeremonyStatus.Failed) {
    return {
      requestId: ceremony.requestId,
      status: ceremony.status,
      error: ceremony.error,
    };
  }
  return { requestId: ceremony.requestId, status: ceremony.status };
}

export function createMockMpcApp(opts: MockMpcAppOpts): Hono {
  const app = new Hono();

  app.use("/v1/*", async (c, next) => {
    const key = extractApiKey(c.req.header("authorization"), c.req.header("x-api-key"));
    if (key !== opts.apiKey) {
      return c.json({ error: CeremonyError.Unauthorized }, 401);
    }
    await next();
  });

  app.get("/v1/wallet", (c) => c.json({ address: opts.address }));

  app.get("/v1/participants", (c) => c.json(participantsBody(opts.store)));

  app.put("/v1/participants", async (c) => {
    let available: ParticipantId[];
    try {
      available = parseAvailable(await c.req.json());
    } catch (err) {
      const message =
        err instanceof InvalidRequestError ? err.message : CeremonyError.InvalidRequest;
      return c.json({ error: CeremonyError.InvalidRequest, message }, 400);
    }
    opts.store.setAvailable(available);
    return c.json(participantsBody(opts.store));
  });

  app.post("/v1/signing-requests", async (c) => {
    const idempotencyKey = c.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return c.json({ error: CeremonyError.InvalidRequest }, 400);
    }

    let json: UnsignedTxJson;
    try {
      json = parseUnsignedTxJson(await c.req.json(), opts.chainId);
    } catch (err) {
      const message =
        err instanceof InvalidRequestError ? err.message : CeremonyError.InvalidRequest;
      return c.json({ error: CeremonyError.InvalidRequest, message }, 400);
    }

    try {
      const ceremony = await opts.store.create(unsignedTxFromJson(json), idempotencyKey);
      return c.json({ requestId: ceremony.requestId, status: ceremony.status }, 202);
    } catch (err) {
      if (err instanceof CeremonyConflictError) {
        return c.json({ error: CeremonyError.IdempotencyConflict }, 409);
      }
      throw err;
    }
  });

  app.get("/v1/signing-requests/:requestId", (c) => {
    const ceremony = opts.store.get(c.req.param("requestId"));
    if (!ceremony) return c.json({ error: CeremonyError.NotFound }, 404);
    return c.json(ceremonyToStatus(ceremony));
  });

  return app;
}
