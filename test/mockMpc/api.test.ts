import { createMockMpcApp } from "src/mockMpc/api.js";
import { CeremonyStore } from "src/mockMpc/ceremonies.js";
import { CeremonyError, CeremonyStatus, unsignedTxToJson } from "src/mockMpc/types.js";
import type { Hex, UnsignedTx } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { readJson } from "test/helpers/json.js";
import { describe, expect, it, vi } from "vitest";

const apiKey = "dev-mpc-secret";
const address = addressFromNumber(1);
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

function appWith(store: CeremonyStore) {
  return createMockMpcApp({ apiKey, chainId: 31337, address, store });
}

function authHeaders(extra?: Record<string, string>) {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

describe("mock MPC vendor API", () => {
  it("rejects missing auth", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const res = await app.request("/v1/wallet");
    expect(res.status).toBe(401);
    expect(await readJson<{ error: string }>(res)).toEqual({ error: CeremonyError.Unauthorized });
  });

  it("returns the wallet address", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const res = await app.request("/v1/wallet", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await readJson<{ address: string }>(res)).toEqual({ address });
  });

  it("returns 400 for a missing idempotency key or invalid tx", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const noKey = await app.request("/v1/signing-requests", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(unsignedTxToJson(sampleTx)),
    });
    expect(noKey.status).toBe(400);

    const badTx = await app.request("/v1/signing-requests", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", "idempotency-key": "k" }),
      body: JSON.stringify({ ...unsignedTxToJson(sampleTx), value: "0x1" }),
    });
    expect(badTx.status).toBe(400);
  });

  it("returns 404 for an unknown request", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const res = await app.request("/v1/signing-requests/missing", { headers: authHeaders() });
    expect(res.status).toBe(404);
    expect(await readJson<{ error: string }>(res)).toEqual({ error: CeremonyError.NotFound });
  });

  it("accepts an idempotent 202 and returns the signed tx only when completed", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const headers = authHeaders({
      "content-type": "application/json",
      "idempotency-key": "same",
    });
    const body = JSON.stringify(unsignedTxToJson(sampleTx));

    const first = await app.request("/v1/signing-requests", { method: "POST", headers, body });
    expect(first.status).toBe(202);
    const created = await readJson<{ requestId: string; status: string }>(first);
    expect(created.status).toBe(CeremonyStatus.Completed);
    expect(created).not.toHaveProperty("signedTransaction");

    const replay = await app.request("/v1/signing-requests", { method: "POST", headers, body });
    expect(replay.status).toBe(202);
    expect(await readJson<{ requestId: string }>(replay)).toEqual({
      requestId: created.requestId,
      status: CeremonyStatus.Completed,
    });

    const got = await app.request(`/v1/signing-requests/${created.requestId}`, {
      headers: authHeaders(),
    });
    expect(got.status).toBe(200);
    expect(await readJson<{ status: string; signedTransaction: string }>(got)).toEqual({
      requestId: created.requestId,
      status: CeremonyStatus.Completed,
      signedTransaction: signed,
    });
  });

  it("returns threshold failure without a signed transaction", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed, available: [0] }));
    const res = await app.request("/v1/signing-requests", {
      method: "POST",
      headers: authHeaders({
        "content-type": "application/json",
        "idempotency-key": "fail",
      }),
      body: JSON.stringify(unsignedTxToJson(sampleTx)),
    });
    expect(res.status).toBe(202);
    const created = await readJson<{ requestId: string; status: string }>(res);
    expect(created.status).toBe(CeremonyStatus.Failed);

    const got = await app.request(`/v1/signing-requests/${created.requestId}`, {
      headers: authHeaders(),
    });
    expect(await readJson<{ status: string; error: string }>(got)).toEqual({
      requestId: created.requestId,
      status: CeremonyStatus.Failed,
      error: CeremonyError.ThresholdNotMet,
    });
  });

  it("returns 409 when an idempotency key is reused with a different payload", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const headers = authHeaders({
      "content-type": "application/json",
      "idempotency-key": "conflict",
    });
    await app.request("/v1/signing-requests", {
      method: "POST",
      headers,
      body: JSON.stringify(unsignedTxToJson(sampleTx)),
    });
    const res = await app.request("/v1/signing-requests", {
      method: "POST",
      headers,
      body: JSON.stringify(unsignedTxToJson({ ...sampleTx, nonce: 1 })),
    });
    expect(res.status).toBe(409);
    expect(await readJson<{ error: string }>(res)).toEqual({
      error: CeremonyError.IdempotencyConflict,
    });
  });

  it("lists participants and accepts an availability update", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const listed = await app.request("/v1/participants", { headers: authHeaders() });
    expect(listed.status).toBe(200);
    expect(
      await readJson<{ threshold: number; participants: number[]; available: number[] }>(listed),
    ).toEqual({
      threshold: 2,
      participants: [0, 1, 2],
      available: [0, 1, 2],
    });

    const updated = await app.request("/v1/participants", {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ available: [0] }),
    });
    expect(updated.status).toBe(200);
    expect(await readJson<{ available: number[] }>(updated)).toMatchObject({ available: [0] });

    const bad = await app.request("/v1/participants", {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ available: [9] }),
    });
    expect(bad.status).toBe(400);
  });

  it("retries a failed signing request after participants are restored", async () => {
    const store = new CeremonyStore({ sign: async () => signed, available: [0] });
    const app = appWith(store);
    const headers = authHeaders({
      "content-type": "application/json",
      "idempotency-key": "intent-1",
    });
    const body = JSON.stringify(unsignedTxToJson(sampleTx));

    const failed = await app.request("/v1/signing-requests", { method: "POST", headers, body });
    expect((await readJson<{ status: string }>(failed)).status).toBe(CeremonyStatus.Failed);

    await app.request("/v1/participants", {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ available: [0, 1] }),
    });

    const retried = await app.request("/v1/signing-requests", { method: "POST", headers, body });
    const created = await readJson<{ requestId: string; status: string }>(retried);
    expect(created.status).toBe(CeremonyStatus.Completed);

    const got = await app.request(`/v1/signing-requests/${created.requestId}`, {
      headers: authHeaders(),
    });
    expect(await readJson<{ signedTransaction: string }>(got)).toMatchObject({
      signedTransaction: signed,
    });
  });

  it("accepts x-api-key auth", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const res = await app.request("/v1/wallet", { headers: { "x-api-key": apiKey } });
    expect(res.status).toBe(200);
    expect(await readJson<{ address: string }>(res)).toEqual({ address });
  });

  it("returns 400 for invalid signing-request bodies", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const headers = authHeaders({
      "content-type": "application/json",
      "idempotency-key": "k",
    });
    const json = unsignedTxToJson(sampleTx);

    const cases: unknown[] = [
      null,
      { ...json, to: "not-an-address" },
      { ...json, nonce: -1 },
      { ...json, nonce: 1.5 },
      { ...json, chainId: 1 },
      { ...json, data: "hello" },
    ];
    for (const body of cases) {
      const res = await app.request("/v1/signing-requests", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("returns 400 for invalid participant updates", async () => {
    const app = appWith(new CeremonyStore({ sign: async () => signed }));
    const headers = authHeaders({ "content-type": "application/json" });
    for (const body of [null, {}, { available: "nope" }]) {
      const res = await app.request("/v1/participants", {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("returns pending or signing status without a signature", async () => {
    const store = new CeremonyStore({ sign: async () => signed });
    const app = appWith(store);
    vi.spyOn(store, "get").mockReturnValueOnce({
      requestId: "req-pending",
      idempotencyKey: "k",
      status: CeremonyStatus.Pending,
      fingerprint: "fp",
      participantsCompleted: 0,
      threshold: 2,
    });
    const pending = await app.request("/v1/signing-requests/req-pending", {
      headers: authHeaders(),
    });
    expect(pending.status).toBe(200);
    expect(await readJson<{ requestId: string; status: string }>(pending)).toEqual({
      requestId: "req-pending",
      status: CeremonyStatus.Pending,
    });

    vi.spyOn(store, "get").mockReturnValueOnce({
      requestId: "req-signing",
      idempotencyKey: "k",
      status: CeremonyStatus.Signing,
      fingerprint: "fp",
      participantsCompleted: 0,
      threshold: 2,
    });
    const signing = await app.request("/v1/signing-requests/req-signing", {
      headers: authHeaders(),
    });
    expect(await readJson<{ status: string }>(signing)).toEqual({
      requestId: "req-signing",
      status: CeremonyStatus.Signing,
    });
  });
});
