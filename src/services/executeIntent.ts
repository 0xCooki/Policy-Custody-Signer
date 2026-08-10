import { appendAuditEvent } from "src/audit/log.js";
import { broadcastSignedTx, waitForTx } from "src/chain/broadcast.js";
import { buildTransferTx } from "src/chain/buildTransferTx.js";
import type { Db } from "src/db/client.js";
import {
  claimIntentForExecution,
  getIntent,
  updateIntentExecution,
  updateIntentStatus,
} from "src/db/intents.js";
import { getWallet } from "src/db/wallets.js";
import type { TransferIntent } from "src/domain/types.js";
import type { Hex, SignerProvider } from "src/signers/types.js";

export async function executeIntent(
  db: Db,
  signer: SignerProvider,
  intentId: string,
  actorId: string,
): Promise<{ intent: TransferIntent; txHash: Hex }> {
  const claim = db.transaction(() => {
    const intent = getIntent(db, intentId);
    if (!intent) throw new Error(`Intent not found: ${intentId}`);
    if (intent.status !== "approved")
      throw new Error(`Intent ${intentId} is ${intent.status}, expected approved`);

    const wallet = getWallet(db, intent.fromWalletId);
    if (!wallet) throw new Error(`Wallet not found: ${intent.fromWalletId}`);

    if (!claimIntentForExecution(db, intentId)) {
      throw new Error(`Intent ${intentId} already claimed for execution`);
    }

    appendAuditEvent(db, {
      type: "SignRequested",
      payload: {
        intentId,
      },
      actor: actorId,
    });

    return { intent, wallet };
  })();

  let txHash: Hex | undefined;

  try {
    const unsignedTx = await buildTransferTx({
      from: claim.wallet.address,
      to: claim.intent.to,
      value: claim.intent.value,
    });
    const signedTx = await signer.signTransaction(unsignedTx);

    txHash = await broadcastSignedTx(signedTx);
    appendAuditEvent(db, {
      type: "TxBroadcast",
      payload: { intentId, txHash },
      actor: actorId,
    });

    await waitForTx(txHash);

    updateIntentExecution(db, intentId, "confirmed", txHash);
    appendAuditEvent(db, {
      type: "TxConfirmed",
      payload: { intentId, txHash },
      actor: actorId,
    });

    const updatedIntent = getIntent(db, intentId);
    if (!updatedIntent) throw new Error(`Intent missing after update: ${intentId}`);
    return { intent: updatedIntent, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : "execute failed";

    if (txHash === undefined) {
      // Build/sign failed: nothing sent and safe to retry
      updateIntentStatus(db, intentId, "approved");
      appendAuditEvent(db, {
        type: "TxFailed",
        payload: { intentId, error: message },
        actor: actorId,
      });
    } else {
      // Broadcast may have landed: fail closed
      updateIntentExecution(db, intentId, "failed", txHash);
      appendAuditEvent(db, {
        type: "TxFailed",
        payload: { intentId, error: message },
        actor: actorId,
      });
    }

    throw new Error(message);
  }
}
