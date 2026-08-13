import { existsSync } from "node:fs";
import type { Pkcs11Client, SoftHsmCfg } from "src/signers/pkcs11Client.js";
import { SoftHsmSigner } from "src/signers/softHsm.js";
import type { Hex, UnsignedTx } from "src/signers/types.js";
import { addressFromNumber } from "src/utils/address.js";
import {
  bytesToBigInt,
  hexToBytes,
  keccak256,
  parseTransaction,
  recoverAddress,
  recoverTransactionAddress,
  serializeTransaction,
  type TransactionSerializedEIP1559,
  toHex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

const modulePath = process.env.SOFTHSM_MODULE_PATH ?? "";
const live = Boolean(modulePath && existsSync(modulePath));

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const mockCfg: SoftHsmCfg = {
  modulePath: "/dev/null",
  pin: "1234",
  slot: 0,
  keyLabel: "test",
};

const liveCfg: SoftHsmCfg = {
  modulePath,
  pin: process.env.SOFTHSM_PIN || "1234",
  slot: Number(process.env.SOFTHSM_SLOT || "0"),
  keyLabel: process.env.SOFTHSM_KEY_LABEL || "custody-eth",
};

const sampleTx: UnsignedTx = {
  to: addressFromNumber(100),
  value: 10n ** 15n,
  nonce: 0,
  gas: 21000n,
  maxFeePerGas: 10n ** 9n,
  maxPriorityFeePerGas: 10n ** 9n,
  chainId: 31337,
};

function mockClient(overrides: Partial<Pkcs11Client> = {}): Pkcs11Client {
  return {
    getPublicKeyPoint: async () => privateKeyToAccount(ANVIL_KEY_0).publicKey,
    signEcdsa: async () => `0x${"11".repeat(64)}`,
    ...overrides,
  };
}

async function rsForTx(
  privateKey: Hex,
  tx: UnsignedTx,
  opts: { highS?: boolean } = {},
): Promise<{ rs: Hex; account: ReturnType<typeof privateKeyToAccount> }> {
  const account = privateKeyToAccount(privateKey);
  const digest = keccak256(serializeTransaction({ ...tx, type: "eip1559" }));
  const lowSig = await sign({ hash: digest, privateKey });
  const lowS = bytesToBigInt(hexToBytes(lowSig.s));
  const s = opts.highS ? toHex(SECP256K1_N - lowS, { size: 32 }) : lowSig.s;
  return { rs: `${lowSig.r}${s.slice(2)}` as Hex, account };
}

describe("SoftHsmSigner (mocked PKCS#11)", () => {
  it("requires key label and module path", () => {
    const client = mockClient();
    expect(() => new SoftHsmSigner({ ...mockCfg, keyLabel: "" }, client)).toThrow(
      /SOFTHSM_KEY_LABEL/,
    );
    expect(() => new SoftHsmSigner({ ...mockCfg, modulePath: "" }, client)).toThrow(
      /SOFTHSM_MODULE_PATH/,
    );
  });

  it("getAddress derives from the PKCS#11 public key point", async () => {
    const account = privateKeyToAccount(ANVIL_KEY_0);
    const signer = new SoftHsmSigner(
      mockCfg,
      mockClient({ getPublicKeyPoint: async () => account.publicKey }),
    );
    expect(await signer.getAddress()).toBe(account.address);
  });

  it("signTransaction keeps already-low-s signatures", async () => {
    const { rs, account } = await rsForTx(ANVIL_KEY_0, sampleTx);
    const sIn = bytesToBigInt(hexToBytes(rs).subarray(32, 64));
    expect(sIn <= SECP256K1_HALF_N).toBe(true);

    const signer = new SoftHsmSigner(
      mockCfg,
      mockClient({
        getPublicKeyPoint: async () => account.publicKey,
        signEcdsa: async () => rs,
      }),
    );
    const signed = (await signer.signTransaction(sampleTx)) as TransactionSerializedEIP1559;
    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(
      account.address,
    );
    const parsed = parseTransaction(signed);
    if (!parsed.s) throw new Error("expected parsed signature s");
    expect(bytesToBigInt(hexToBytes(parsed.s))).toBe(sIn);
  });

  it("normalizes high-s PKCS#11 signatures so Ethereum accepts them", async () => {
    const { rs, account } = await rsForTx(ANVIL_KEY_0, sampleTx, { highS: true });
    expect(bytesToBigInt(hexToBytes(rs).subarray(32, 64)) > SECP256K1_HALF_N).toBe(true);

    const signer = new SoftHsmSigner(
      mockCfg,
      mockClient({
        getPublicKeyPoint: async () => account.publicKey,
        signEcdsa: async () => rs,
      }),
    );
    const signed = (await signer.signTransaction(sampleTx)) as TransactionSerializedEIP1559;
    expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(
      account.address,
    );

    const parsed = parseTransaction(signed);
    if (!parsed.s) throw new Error("expected parsed signature s");
    expect(bytesToBigInt(hexToBytes(parsed.s)) <= SECP256K1_HALF_N).toBe(true);
  });

  it("signTransaction recovers both yParity values", async () => {
    const seen = new Set<bigint>();
    for (let nonce = 0; nonce < 32 && seen.size < 2; nonce++) {
      const tx = { ...sampleTx, nonce };
      const { rs, account } = await rsForTx(ANVIL_KEY_0, tx);
      const digest = keccak256(serializeTransaction({ ...tx, type: "eip1559" }));
      const r = toHex(hexToBytes(rs).subarray(0, 32));
      const s = toHex(hexToBytes(rs).subarray(32, 64));
      const r0 = (await recoverAddress({ hash: digest, signature: { r, s, v: 0n } })).toLowerCase();
      const expected = account.address.toLowerCase();
      seen.add(r0 === expected ? 0n : 1n);

      const signer = new SoftHsmSigner(
        mockCfg,
        mockClient({
          getPublicKeyPoint: async () => account.publicKey,
          signEcdsa: async () => rs,
        }),
      );
      const signed = (await signer.signTransaction(tx)) as TransactionSerializedEIP1559;
      expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(
        account.address,
      );
    }
    expect(seen.size).toBe(2);
  });

  it("rejects non-64-byte ECDSA payloads", async () => {
    const signer = new SoftHsmSigner(
      mockCfg,
      mockClient({ signEcdsa: async () => `0x${"11".repeat(32)}` as Hex }),
    );
    await expect(signer.signTransaction(sampleTx)).rejects.toThrow(/64 bytes/);
  });

  it("throws when yParity cannot be recovered", async () => {
    const { rs } = await rsForTx(ANVIL_KEY_0, sampleTx);
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
    );
    const signer = new SoftHsmSigner(
      mockCfg,
      mockClient({
        getPublicKeyPoint: async () => other.publicKey,
        signEcdsa: async () => rs,
      }),
    );
    await expect(signer.signTransaction(sampleTx)).rejects.toThrow(/yParity/);
  });

  it("close invokes the PKCS#11 client close hook", () => {
    const close = vi.fn();
    const signer = new SoftHsmSigner(mockCfg, mockClient({ close }));
    signer.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("close is a no-op when the client has no close hook", () => {
    const signer = new SoftHsmSigner(mockCfg, mockClient());
    expect(() => signer.close()).not.toThrow();
  });
});

describe.skipIf(!live)("SoftHsmSigner (live SoftHSM)", () => {
  it("getAddress + signTransaction recover to the SoftHSM key", async () => {
    const signer = new SoftHsmSigner(liveCfg);
    try {
      const address = await signer.getAddress();
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);

      const signed = (await signer.signTransaction(sampleTx)) as TransactionSerializedEIP1559;
      const recovered = await recoverTransactionAddress({ serializedTransaction: signed });
      expect(recovered).toBe(address);
    } finally {
      signer.close();
    }
  });
});
