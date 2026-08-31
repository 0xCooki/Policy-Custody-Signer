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
    expect(hashesEqual("0xabc", undefined)).toBe(false);
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

  it.each([
    { name: "matching transfer", tx: matching, ok: true },
    { name: "zero-padded empty input", tx: { ...matching, input: "0x00" }, ok: true },
    { name: "different to", tx: { ...matching, to: addressFromNumber(201) }, ok: false },
    { name: "different value", tx: { ...matching, value: value + 1n }, ok: false },
    { name: "different from", tx: { ...matching, from: addressFromNumber(99) }, ok: false },
    { name: "calldata", tx: { ...matching, input: "0xabcd" }, ok: false },
    { name: "null to", tx: { ...matching, to: null }, ok: false },
  ] as const)("$name", ({ tx, ok }) => {
    expect(txMatchesIntent(tx, intent, from)).toBe(ok);
  });
});

describe("decodeSignedRawTx", () => {
  const signer = new LocalKeySigner(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const to = addressFromNumber(200);
  const value = 10n ** 15n;

  it("returns undefined for bytes that are not a signed transfer", async () => {
    expect(await decodeSignedRawTx("0xdead" as Hex)).toBeUndefined();
  });

  it("decodes a signed transfer and matches the intent", async () => {
    const from = await signer.getAddress();
    const signed = await signer.signTransaction({
      to,
      value,
      nonce: 0,
      gas: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      chainId: 31337,
    });
    const decoded = await decodeSignedRawTx(signed);
    expect(decoded).toEqual({ to, from, value, input: "0x" });
    if (decoded === undefined) return;
    expect(
      txMatchesIntent(
        decoded,
        {
          id: "intent",
          fromWalletId: "wallet",
          to,
          value,
          asset: Asset.Eth,
          initiatorId: "dev-initiator",
          status: IntentStatus.Broadcast,
          createdAt: new Date().toISOString(),
        },
        from,
      ),
    ).toBe(true);
  });
});
