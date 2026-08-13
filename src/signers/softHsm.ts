import {
  createGraphenePkcs11Client,
  type Pkcs11Client,
  type SoftHsmCfg,
} from "src/signers/pkcs11Client.js";
import {
  type Address,
  type Hex,
  SignerBackend,
  type SignerProvider,
  type UnsignedTx,
} from "src/signers/types.js";
import {
  bytesToBigInt,
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeTransaction,
  toHex,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";

/** secp256k1 curve order; Ethereum requires s <= n/2 (EIP-2). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

export class SoftHsmSigner implements SignerProvider {
  readonly name = SignerBackend.SoftHsm;
  private readonly client: Pkcs11Client;

  constructor(cfg: SoftHsmCfg, client?: Pkcs11Client) {
    if (!cfg.keyLabel) {
      throw new Error("SOFTHSM_KEY_LABEL is required for SoftHsmSigner");
    }
    if (!cfg.modulePath) {
      throw new Error("SOFTHSM_MODULE_PATH is required for SoftHsmSigner");
    }

    this.client = client ?? createGraphenePkcs11Client(cfg);
  }

  async getAddress(): Promise<Address> {
    const point = await this.client.getPublicKeyPoint();
    return publicKeyToAddress(point);
  }

  async signTransaction(tx: UnsignedTx): Promise<Hex> {
    const txFields = {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      nonce: tx.nonce,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      chainId: tx.chainId,
      type: "eip1559" as const,
    };

    const digest = keccak256(serializeTransaction(txFields));
    const rs = await this.client.signEcdsa(digest);
    const bytes = hexToBytes(rs);
    if (bytes.length !== 64) {
      throw new Error(`SoftHSM signature must be 64 bytes, got ${bytes.length}`);
    }

    const r = toHex(bytes.subarray(0, 32));
    let sBig = bytesToBigInt(bytes.subarray(32, 64));
    // PKCS#11 ECDSA is not EIP-2; flip high-s so nodes accept the raw tx.
    if (sBig > SECP256K1_HALF_N) {
      sBig = SECP256K1_N - sBig;
    }
    const s = toHex(sBig, { size: 32 });

    let v: bigint;
    const expected = (await this.getAddress()).toLowerCase();
    const r0 = (await recoverAddress({ hash: digest, signature: { r, s, v: 0n } })).toLowerCase();
    const r1 = (await recoverAddress({ hash: digest, signature: { r, s, v: 1n } })).toLowerCase();
    if (r0 === expected) {
      v = 0n;
    } else if (r1 === expected) {
      v = 1n;
    } else throw new Error("Failed to recover yParity for SoftHSM signature");

    return serializeTransaction(txFields, { r, s, v });
  }

  close(): void {
    this.client.close?.();
  }
}
