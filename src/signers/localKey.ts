import type { Address, Hex, SignerProvider, UnsignedTx } from "src/signers/types.js";
import { privateKeyToAccount } from "viem/accounts";

export class LocalKeySigner implements SignerProvider {
  readonly name = "local" as const;
  private readonly account;

  constructor(privateKey: Hex) {
    if (!privateKey || privateKey === "0x") {
      throw new Error("LOCAL_PRIVATE_KEY is required for LocalKeySigner (DEV ONLY / UNSAFE)");
    }
    this.account = privateKeyToAccount(privateKey);
    //console.warn("[LocalKeySigner] DEV ONLY / UNSAFE: local private key in process memory");
  }

  async getAddress(): Promise<Address> {
    return this.account.address;
  }

  async signTransaction(tx: UnsignedTx): Promise<Hex> {
    return this.account.signTransaction({
      to: tx.to,
      value: tx.value,
      data: tx.data,
      nonce: tx.nonce,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      chainId: tx.chainId,
      type: "eip1559",
    });
  }
}
