import {
  fingerprintTx,
  unsignedTxFromJson,
  unsignedTxToJson,
} from "src/signers/mockMpcProtocol.js";
import type { Hex, UnsignedTx } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import { describe, expect, it } from "vitest";

const sampleTx: UnsignedTx = {
  to: addressFromNumber(100),
  value: 10n ** 15n,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 10n ** 9n,
  maxPriorityFeePerGas: 10n ** 9n,
  chainId: 31337,
};

describe("mockMpcProtocol", () => {
  it("round-trips an unsigned tx without data", () => {
    expect(unsignedTxFromJson(unsignedTxToJson(sampleTx))).toEqual(sampleTx);
  });

  it("round-trips an unsigned tx with data", () => {
    const withData: UnsignedTx = { ...sampleTx, data: "0xabcd" as Hex };
    const json = unsignedTxToJson(withData);
    expect(json.data).toBe("0xabcd");
    expect(unsignedTxFromJson(json)).toEqual(withData);
    expect(unsignedTxToJson(sampleTx)).not.toHaveProperty("data");
  });

  it("fingerprints without gas or fees", () => {
    expect(fingerprintTx({ ...sampleTx, gas: 22000n, maxFeePerGas: 99n })).toBe(
      fingerprintTx(sampleTx),
    );
  });

  it("changes fingerprint when nonce, to, or data differ", () => {
    const withData: UnsignedTx = { ...sampleTx, data: "0xABCD" as Hex };
    expect(fingerprintTx({ ...sampleTx, nonce: 1 })).not.toBe(fingerprintTx(sampleTx));
    expect(fingerprintTx({ ...sampleTx, to: addressFromNumber(200) })).not.toBe(
      fingerprintTx(sampleTx),
    );
    expect(fingerprintTx(withData)).not.toBe(fingerprintTx(sampleTx));
    expect(fingerprintTx(withData)).toBe(fingerprintTx({ ...sampleTx, data: "0xabcd" as Hex }));
  });
});
