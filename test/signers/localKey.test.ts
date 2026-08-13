import { LocalKeySigner } from "src/signers/localKey.js";
import type { Hex, UnsignedTx } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it } from "vitest";

const ANVIL_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

describe("LocalKeySigner", () => {
  it("rejects a missing or empty private key", () => {
    expect(() => new LocalKeySigner("0x" as Hex)).toThrow(/LOCAL_PRIVATE_KEY/);
    expect(() => new LocalKeySigner("" as Hex)).toThrow(/LOCAL_PRIVATE_KEY/);
  });

  it("Derives Anvil account #0 address", async () => {
    const signer = new LocalKeySigner(ANVIL_ACCOUNT_0);
    expect(await signer.getAddress()).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("Signs an unsigned tx to hex ", async () => {
    const signer = new LocalKeySigner(ANVIL_ACCOUNT_0);
    const tx: UnsignedTx = {
      to: addressFromNumber(100),
      value: 10n ** 18n,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n,
      chainId: 31337,
    };
    const signed = await signer.signTransaction(tx);
    expect(signed.startsWith("0x")).toBe(true);
    expect(signed.length).toBeGreaterThan(2);
  });
});
