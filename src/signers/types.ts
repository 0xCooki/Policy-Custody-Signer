import type { Address, Hex } from "viem";

export type { Address, Hex };

export const SignerBackend = {
  Local: "local",
  SoftHsm: "softhsm",
  MockMpc: "mock-mpc",
} as const;
export type SignerBackend = (typeof SignerBackend)[keyof typeof SignerBackend];

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
