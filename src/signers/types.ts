import type { Address, Hex } from "viem";

export type { Address, Hex };

export type SignerBackend = "local" | "softhsm" | "mock-mpc";

export type UnsignedTx = {
  to: Address;
  value: bigint;
  data?: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: number;
};

export interface SignerProvider {
  readonly name: SignerBackend;
  getAddress(): Promise<Address>;
  signTransaction(tx: UnsignedTx): Promise<Hex>;
}
