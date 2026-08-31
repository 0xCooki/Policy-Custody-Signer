import { appendAuditEvent } from "src/audit/log.js";
import { broadcastSignedTx, waitForTx } from "src/chain/broadcast.js";
import { buildTransferTx } from "src/chain/buildTransferTx.js";
import type { Db } from "src/db/client.js";
import {
  claimIntentForExecution,
  getIntent,
  isUniqueConstraintError,
  persistBroadcastSignature,
  walletHasBroadcastIntent,
} from "src/db/intents.js";
import { getWallet } from "src/db/wallets.js";
import type { TransferIntent } from "src/domain/types.js";
import { ApiErrorCode, AuditEventType, IntentStatus } from "src/domain/types.js";
import {
  decodeSignedRawTx,
  hashesEqual,
  markBroadcastOutcome,
  receiptError,
  requireIntent,
  txMatchesIntent,
  unclaimIdleBroadcast,
} from "src/services/broadcastOutcome.js";
import { acquireExecution, releaseExecution } from "src/services/executionLock.js";
import type { Hex, SignerProvider } from "src/signers/types.js";
import { AppError } from "src/utils/errors.js";
import { keccak256 } from "viem";

export async function executeIntent(
  db: Db,
  signer: SignerProvider,
  intentId: string,
  actorId: string,
): Promise<{ intent: TransferIntent; txHash: Hex }> {
  const lock = acquireExecution(intentId);
  let claimed = false;
  let txHash: Hex | undefined;
  let signed = false;

  try {
    const claim = db
      .transaction(() => {
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

        if (walletHasBroadcastIntent(db, intent.fromWalletId)) {
          throw new AppError(
            ApiErrorCode.AlreadyClaimed,
            `Wallet ${intent.fromWalletId} already has a broadcast intent`,
          );
        }

        try {
          if (!claimIntentForExecution(db, intentId)) {
            throw new AppError(
              ApiErrorCode.AlreadyClaimed,
              `Intent ${intentId} already claimed for execution`,
            );
          }
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            throw new AppError(
              ApiErrorCode.AlreadyClaimed,
              `Wallet ${intent.fromWalletId} already has a broadcast intent`,
            );
          }
          throw err;
        }

        return { intent, wallet };
      })
      .immediate();
    claimed = true;

    const unsignedTx = await buildTransferTx({
      from: claim.wallet.address,
      to: claim.intent.to,
      value: claim.intent.value,
    });
    const signedTx = await signer.signTransaction(unsignedTx, { idempotencyKey: intentId });
    const decoded = await decodeSignedRawTx(signedTx);
    if (decoded === undefined || !txMatchesIntent(decoded, claim.intent, claim.wallet.address)) {
      throw new AppError(ApiErrorCode.ReconcileMismatch, "signed tx does not match intent");
    }
    const broadcastHash = keccak256(signedTx);

    // Persist hash+raw in its own commit so an audit write failure cannot
    // roll back the only copy of a signature. Mark signed only after this
    // commit: a failed persist was never sent and is safe to unclaim.
    if (!persistBroadcastSignature(db, intentId, broadcastHash, signedTx)) {
      throw new AppError(
        ApiErrorCode.InvalidStatus,
        `Intent ${intentId} is no longer claimed for execution`,
      );
    }
    signed = true;
    txHash = broadcastHash;
    // Hash+raw are durable: drop this claim so a hung send/wait does not block
    // reconcile. finally still runs releaseExecution(lock); that is a no-op once
    // this token is no longer the holder.
    releaseExecution(lock);
    appendAuditEvent(db, {
      type: AuditEventType.SignRequested,
      payload: { intentId, txHash: broadcastHash },
      actor: actorId,
    });

    const sentHash = await broadcastSignedTx(signedTx);
    if (!hashesEqual(sentHash, broadcastHash)) {
      throw new Error(`broadcast hash mismatch: expected ${broadcastHash}, got ${sentHash}`);
    }
    appendAuditEvent(db, {
      type: AuditEventType.TxBroadcast,
      payload: { intentId, txHash: broadcastHash },
      actor: actorId,
    });

    const receipt = await waitForTx(txHash);
    if (receipt.status !== "success") {
      markBroadcastOutcome(db, {
        intentId,
        actorId,
        txHash,
        status: IntentStatus.Failed,
        type: AuditEventType.TxFailed,
        payload: {
          intentId,
          txHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          error: receiptError(receipt.status),
        },
      });
      const latest = requireIntent(db, intentId);
      if (latest.status === IntentStatus.Confirmed && hashesEqual(latest.txHash, txHash)) {
        return { intent: latest, txHash };
      }
      throw new AppError(ApiErrorCode.TxReverted, receiptError(receipt.status));
    }

    markBroadcastOutcome(db, {
      intentId,
      actorId,
      txHash,
      status: IntentStatus.Confirmed,
      type: AuditEventType.TxConfirmed,
      payload: {
        intentId,
        txHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
      },
    });

    const updatedIntent = requireIntent(db, intentId);
    if (
      updatedIntent.status === IntentStatus.Confirmed &&
      hashesEqual(updatedIntent.txHash, txHash)
    ) {
      return { intent: updatedIntent, txHash };
    }
    if (updatedIntent.status === IntentStatus.Failed) {
      throw new AppError(ApiErrorCode.TxReverted, "receipt status is not success");
    }
    throw new AppError(ApiErrorCode.InvalidStatus, `Intent ${intentId} is ${updatedIntent.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "execute failed";

    if (claimed && txHash === undefined && !signed) {
      unclaimIdleBroadcast(db, intentId, actorId, message);
    }

    if (err instanceof AppError) throw err;
    throw new Error(message);
  } finally {
    releaseExecution(lock);
  }
}
