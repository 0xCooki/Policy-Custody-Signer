import { config } from "src/config.js";
import { addressFromNumber } from "src/utils/address.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTransactionCount = vi.fn();
const estimateFeesPerGas = vi.fn();

vi.mock("src/chain/client.js", () => ({
  publicClient: {
    getTransactionCount,
    estimateFeesPerGas,
  },
}));

const { buildTransferTx } = await import("src/chain/buildTransferTx.js");

describe("buildTransferTx", () => {
  beforeEach(() => {
    getTransactionCount.mockReset();
    estimateFeesPerGas.mockReset();
  });

  it("falls back to 1 gwei when fee estimates are missing", async () => {
    const from = addressFromNumber(1);
    const to = addressFromNumber(200);
    getTransactionCount.mockResolvedValueOnce(7);
    estimateFeesPerGas.mockResolvedValueOnce({
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    });

    const tx = await buildTransferTx({ from, to, value: 10n ** 15n });
    expect(tx).toEqual({
      to,
      value: 10n ** 15n,
      nonce: 7,
      gas: 21_000n,
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n,
      chainId: config.chainId,
    });
    expect(getTransactionCount).toHaveBeenCalledWith({ address: from });
  });
});
