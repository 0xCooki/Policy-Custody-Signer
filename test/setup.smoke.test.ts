import { app } from "src/api/index.js";
import { config } from "src/config.js";
import type { TransferIntent } from "src/domain/types.js";
import { describe, expect, it } from "vitest";

describe("repo setup", () => {
  it("loads config with a selectable signer backend", () => {
    expect(["local", "softhsm", "mock-mpc"]).toContain(config.signerBackend);
  });

  it("responds to GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      signerBackend: config.signerBackend,
    });
  });

  it("shapes a transfer intent as native ETH", () => {
    const intent: TransferIntent = {
      id: "intent_1",
      fromWalletId: "wallet_1",
      to: "0x0000000000000000000000000000000000000002",
      value: 10n ** 18n,
      asset: "ETH",
      initiatorId: "initiator",
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    expect(intent.asset).toBe("ETH");
    expect(intent.status).toBe("pending");
  });
});
