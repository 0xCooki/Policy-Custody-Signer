import { app } from "src/api/index.js";
import { config } from "src/config.js";
import type { TransferIntent } from "src/domain/types.js";
import { Asset, IntentStatus } from "src/domain/types.js";
import { SignerBackend } from "src/signers/types.js";
import { describe, expect, it } from "vitest";

describe("Repo Setup", () => {
  it("Loads config with a selectable signer backend", () => {
    expect(Object.values(SignerBackend)).toContain(config.signerBackend);
  });

  it("Responds to GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      signerBackend: config.signerBackend,
    });
  });

  it("Shapes a transfer intent as native ETH", () => {
    const intent: TransferIntent = {
      id: "intent_1",
      fromWalletId: "wallet_1",
      to: "0x0000000000000000000000000000000000000002",
      value: 10n ** 18n,
      asset: Asset.Eth,
      initiatorId: "initiator",
      status: IntentStatus.Pending,
      createdAt: new Date().toISOString(),
    };

    expect(intent.asset).toBe(Asset.Eth);
    expect(intent.status).toBe(IntentStatus.Pending);
  });
});
