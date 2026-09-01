import { app } from "src/api/index.js";
import { ApiErrorCode } from "src/domain/types.js";
import { describe, expect, it } from "vitest";

describe("Auth middleware", () => {
  it("responds to GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("returns 401 when API key is missing", async () => {
    const res = await app.request("/wallets", { method: "GET" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: ApiErrorCode.Unauthorized });
  });

  it("returns 401 for an unknown API key", async () => {
    const res = await app.request("/wallets", {
      method: "GET",
      headers: { Authorization: "Bearer unknown-key" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: ApiErrorCode.Unauthorized });
  });

  it("returns 403 when role is not allowed", async () => {
    const res = await app.request("/wallets", {
      method: "GET",
      headers: { Authorization: "Bearer dev-initiator" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ApiErrorCode.Forbidden });
  });

  it("accepts x-api-key as an alternative to Authorization", async () => {
    const res = await app.request("/wallets", {
      method: "GET",
      headers: { "x-api-key": "dev-admin" },
    });
    expect(res.status).toBe(200);
  });

  it("lists wallets for admin", async () => {
    const res = await app.request("/wallets", {
      method: "GET",
      headers: { Authorization: "Bearer dev-admin" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.any(Array));
  });
});
