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
import { ApiErrorCode, AuditEventType, IntentStatus } from "src/domain/types.js";
import type { Hex, SignerProvider } from "src/signers/types.js";
import { AppError } from "src/utils/errors.js";

export async function executeIntent(
  db: Db,
  signer: SignerProvider,
  intentId: string,
  actorId: string,
): Promise<{ intent: TransferIntent; txHash: Hex }> {
  const claim = db.transaction(() => {
    const intent = getIntent(db, intentId);
    if (!intent) throw new AppError(ApiErrorCode.NotFound, `Intent not found: ${intentId}`);
    if (intent.status !== IntentStatus.Approved) {
      throw new AppError(
        ApiErrorCode.InvalidStatus,
        `Intent ${intentId} is ${intent.status}, expected ${IntentStatus.Approved}`,
      );
    }

    const wallet = getWallet(db, intent.fromWalletId);
    if (!wallet)
      throw new AppError(ApiErrorCode.NotFound, `Wallet not found: ${intent.fromWalletId}`);

    if (!claimIntentForExecution(db, intentId)) {
      throw new AppError(
        ApiErrorCode.AlreadyClaimed,
        `Intent ${intentId} already claimed for execution`,
      );
    }

    appendAuditEvent(db, {
      type: AuditEventType.SignRequested,
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
    const signedTx = await signer.signTransaction(unsignedTx, { idempotencyKey: intentId });

    txHash = await broadcastSignedTx(signedTx);
    appendAuditEvent(db, {
      type: AuditEventType.TxBroadcast,
      payload: { intentId, txHash },
      actor: actorId,
    });

    const receipt = await waitForTx(txHash);
    if (receipt.status !== "success") {
      updateIntentExecution(db, intentId, IntentStatus.Failed, txHash);
      appendAuditEvent(db, {
        type: AuditEventType.TxFailed,
        payload: {
          intentId,
          txHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          error: "receipt status is not success",
        },
        actor: actorId,
      });
      throw new AppError(ApiErrorCode.TxReverted, "receipt status is not success");
    }

    updateIntentExecution(db, intentId, IntentStatus.Confirmed, txHash);
    appendAuditEvent(db, {
      type: AuditEventType.TxConfirmed,
      payload: {
        intentId,
        txHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
      },
      actor: actorId,
    });

    const updatedIntent = getIntent(db, intentId);
    if (!updatedIntent) {
      throw new AppError(ApiErrorCode.NotFound, `Intent missing after update: ${intentId}`);
    }
    return { intent: updatedIntent, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : "execute failed";

    if (txHash === undefined) {
      // Build/sign failed (including AppError): nothing sent and safe to retry
      updateIntentStatus(db, intentId, IntentStatus.Approved);
      appendAuditEvent(db, {
        type: AuditEventType.TxFailed,
        payload: { intentId, error: message },
        actor: actorId,
      });
    } else if (!(err instanceof AppError)) {
      // Broadcast may have landed: fail closed (skip for post-confirm AppError)
      updateIntentExecution(db, intentId, IntentStatus.Failed, txHash);
      appendAuditEvent(db, {
        type: AuditEventType.TxFailed,
        payload: { intentId, error: message },
        actor: actorId,
      });
    }

    if (err instanceof AppError) throw err;
    throw new Error(message);
  }
}
