import { publicClient } from "src/chain/client.js";
import type { Hex } from "src/signers/types.js";

export async function broadcastSignedTx(signedRawTx: Hex): Promise<Hex> {
  return await publicClient.sendRawTransaction({
    serializedTransaction: signedRawTx,
  });
}

export async function waitForTx(txHash: Hex) {
  return publicClient.waitForTransactionReceipt({ hash: txHash });
}

export async function getTxReceipt(txHash: Hex) {
  return publicClient.getTransactionReceipt({ hash: txHash });
}

export async function getTx(txHash: Hex) {
  return publicClient.getTransaction({ hash: txHash });
}
