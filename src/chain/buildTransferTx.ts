import { publicClient } from "src/chain/client.js";
import { config } from "src/config.js";
import type { Address, UnsignedTx } from "src/signers/types.js";

export async function buildTransferTx(input: {
  from: Address;
  to: Address;
  value: bigint;
}): Promise<UnsignedTx> {
  const nonce = await publicClient.getTransactionCount({ address: input.from });
  const gas = 21_000n;
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas ?? 10n ** 9n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 10n ** 9n;

  return {
    to: input.to,
    value: input.value,
    nonce: nonce,
    gas: gas,
    maxFeePerGas: maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas,
    chainId: config.chainId,
  };
}
