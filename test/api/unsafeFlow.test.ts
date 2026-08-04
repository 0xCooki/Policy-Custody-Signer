import { app } from "src/api/index.js";
import { publicClient } from "src/chain/client.js";
import { addressFromNumber } from "src/utils/address.js";
import { beforeAll, describe, expect, it } from "vitest";

describe("unsafe intent → sign → tx hash (Anvil required)", () => {
  beforeAll(async () => {
    try {
      await publicClient.getBlockNumber();
    } catch {
      throw new Error("Anvil is required for this suite. Start it in another terminal: anvil");
    }
  });

  it("POST wallet → intent → execute returns a tx hash", async () => {
    // Post wallet
    const walletRes = await app.request("/wallets", { method: "POST" });
    expect(walletRes.status).toBe(201);
    const wallet = await walletRes.json();
    expect(wallet.address).toMatch(/^0x/);

    // Post Intent
    const intentRes = await app.request("/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromWalletId: wallet.id,
        to: addressFromNumber(200),
        value: (10n ** 15n).toString(),
      }),
    });
    expect(intentRes.status).toBe(201);
    const intent = await intentRes.json();
    expect(intent.status).toBe("pending");

    // Execute intent
    const execRes = await app.request(`/intents/${intent.id}/execute`, {
      method: "POST",
    });
    expect(execRes.status).toBe(200);
    const body = await execRes.json();
    expect(body.txHash).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(body.intent.status).toBe("confirmed");
    expect(body.intent.txHash).toBe(body.txHash);

    const receipt = await publicClient.getTransactionReceipt({
      hash: body.txHash,
    });
    expect(receipt.status).toBe("success");
  });
});
