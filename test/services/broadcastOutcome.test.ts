import { Asset, IntentStatus } from "src/domain/types.js";
import { decodeSignedRawTx, hashesEqual, txMatchesIntent } from "src/services/broadcastOutcome.js";
import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it } from "vitest";

describe("hashesEqual", () => {
  it("compares hex case-insensitively and treats missing values as unequal", () => {
    expect(hashesEqual("0xabc", "0xABC")).toBe(true);
    expect(hashesEqual("0xabc", "0xabd")).toBe(false);
    expect(hashesEqual(undefined, undefined)).toBe(false);
  });
});

describe("txMatchesIntent", () => {
  const to = addressFromNumber(200);
  const from = addressFromNumber(1);
  const value = 10n ** 15n;
  const intent = {
    id: "intent",
    fromWalletId: "wallet",
    to,
    value,
    asset: Asset.Eth,
    initiatorId: "dev-initiator",
    status: IntentStatus.Broadcast,
    createdAt: new Date().toISOString(),
  };
  const matching = { to, from, value, input: "0x" };

  it("accepts an empty-data transfer and rejects calldata or a different destination", () => {
    expect(txMatchesIntent(matching, intent, from)).toBe(true);
    expect(txMatchesIntent({ ...matching, input: "0x00" }, intent, from)).toBe(false);
    expect(txMatchesIntent({ ...matching, to: addressFromNumber(201) }, intent, from)).toBe(false);
  });
});

describe("decodeSignedRawTx", () => {
  it("decodes a signed transfer and rejects garbage", async () => {
    const signer = new LocalKeySigner(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const to = addressFromNumber(200);
    const signed = await signer.signTransaction({
      to,
      value: 10n ** 15n,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      chainId: 31337,
    });
    const decoded = await decodeSignedRawTx(signed);
    expect(decoded).toEqual({
      to,
      from: await signer.getAddress(),
      value: 10n ** 15n,
      input: "0x",
    });
    expect(await decodeSignedRawTx("0xdead" as Hex)).toBeUndefined();
  });
});
