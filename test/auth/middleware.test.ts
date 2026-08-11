import { app } from "src/api/index.js";
import { ApiErrorCode } from "src/domain/types.js";
import { describe, expect, it } from "vitest";

describe("Auth middleware", () => {
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
});
