import type { Address, Hex, UnsignedTx } from "src/signers/types.js";

/** Wire statuses for the mock MPC vendor HTTP API. */
export const CeremonyStatus = {
  Pending: "pending",
  Signing: "signing",
  Completed: "completed",
  Failed: "failed",
} as const;
export type CeremonyStatus = (typeof CeremonyStatus)[keyof typeof CeremonyStatus];

export type UnsignedTxJson = {
  to: Address;
  value: string;
  data?: Hex;
  nonce: number;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  chainId: number;
};

export function unsignedTxToJson(tx: UnsignedTx): UnsignedTxJson {
  return {
    to: tx.to,
    value: tx.value.toString(),
    ...(tx.data !== undefined ? { data: tx.data } : {}),
    nonce: tx.nonce,
    gas: tx.gas.toString(),
    maxFeePerGas: tx.maxFeePerGas.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
    chainId: tx.chainId,
  };
}

export function unsignedTxFromJson(json: UnsignedTxJson): UnsignedTx {
  return {
    to: json.to,
    value: BigInt(json.value),
    ...(json.data !== undefined ? { data: json.data } : {}),
    nonce: json.nonce,
    gas: BigInt(json.gas),
    maxFeePerGas: BigInt(json.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(json.maxPriorityFeePerGas),
    chainId: json.chainId,
  };
}

/** Identity of a transfer for idempotency — excludes gas and fees, which can change on retry. */
export function fingerprintTx(tx: UnsignedTx): string {
  return JSON.stringify({
    to: tx.to.toLowerCase(),
    value: tx.value.toString(),
    ...(tx.data !== undefined ? { data: tx.data.toLowerCase() } : {}),
    nonce: tx.nonce,
    chainId: tx.chainId,
  });
}
