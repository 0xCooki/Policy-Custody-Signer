import { config } from "src/config.js";
import { MOCK_MPC_DEV_KEY } from "src/mockMpc/ceremonies.js";
import { app } from "src/mockMpc/index.js";
import { readJson } from "test/helpers/json.js";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

describe("mock MPC index wiring", () => {
  it("serves the wallet from config without starting a listener", async () => {
    const res = await app.request("/v1/wallet", {
      headers: { authorization: `Bearer ${config.mockMpc.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(await readJson<{ address: string }>(res)).toEqual({
      address: privateKeyToAccount(MOCK_MPC_DEV_KEY).address,
    });
  });
});
