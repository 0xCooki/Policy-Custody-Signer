import { broadcastSignedTx, waitForTx } from "src/chain/broadcast.js";
import { buildTransferTx } from "src/chain/buildTransferTx.js";
import type { Db } from "src/db/client.js";
import { getIntent, updateIntentExecution } from "src/db/intents.js";
import { getWallet } from "src/db/wallets.js";
import type { TransferIntent } from "src/domain/types.js";
import type { Hex, SignerProvider } from "src/signers/types.js";

export async function executeIntent(
  db: Db,
  signer: SignerProvider,
  intentId: string,
): Promise<{ intent: TransferIntent; txHash: Hex }> {
  // Get the intent from the database
  const intent = getIntent(db, intentId);
  if (!intent) throw new Error(`Intent not found: ${intentId}`);
  if (intent.status !== "pending")
    throw new Error(`Intent ${intentId} is ${intent.status}, expected pending`);

  // Get the wallet from the database
  const wallet = getWallet(db, intent.fromWalletId);
  if (!wallet) throw new Error(`Wallet not found: ${intent.fromWalletId}`);

  // Unsafe path: no policy or approvals, immediate signature and broadcast
  const unsignedTx = await buildTransferTx({
    from: wallet.address,
    to: intent.to,
    value: intent.value,
  });
  const signedTx = await signer.signTransaction(unsignedTx);
  const txHash = await broadcastSignedTx(signedTx);
  await waitForTx(txHash);

  // Update the database
  updateIntentExecution(db, intentId, "confirmed", txHash);
  const updatedIntent = getIntent(db, intentId);
  if (!updatedIntent) throw new Error(`Intent missing after update: ${intentId}`);

  return { intent: updatedIntent, txHash };
}
