import { appendAuditEvent } from "src/audit/log.js";
import { broadcastSignedTx, getTx, getTxReceipt } from "src/chain/broadcast.js";
import type { Db } from "src/db/client.js";
import { getIntent, getIntentSignedRawTx } from "src/db/intents.js";
import { getWallet } from "src/db/wallets.js";
import type { TransferIntent } from "src/domain/types.js";
import { ApiErrorCode, AuditEventType, IntentStatus } from "src/domain/types.js";
import {
  decodeSignedRawTx,
  failMismatch,
  hashesEqual,
  markBroadcastOutcome,
  requireIntent,
  txMatchesIntent,
  unclaimIdleBroadcast,
} from "src/services/broadcastOutcome.js";
import { acquireExecution, releaseExecution } from "src/services/executionLock.js";
import type { Hex } from "src/signers/types.js";
import { AppError } from "src/utils/errors.js";
import { keccak256, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem";

export async function reconcileIntent(
  db: Db,
  intentId: string,
  actorId: string,
): Promise<{ intent: TransferIntent; txHash?: Hex }> {
  const intent = getIntent(db, intentId);
  if (!intent) throw new AppError(ApiErrorCode.NotFound, `Intent not found: ${intentId}`);
  if (intent.status === IntentStatus.Confirmed || intent.status === IntentStatus.Failed) {
    return { intent, txHash: intent.txHash };
  }
  if (intent.status !== IntentStatus.Broadcast) {
    throw new AppError(
      ApiErrorCode.InvalidStatus,
      `Intent ${intentId} is ${intent.status}, expected ${IntentStatus.Broadcast}`,
    );
  }

  const wallet = getWallet(db, intent.fromWalletId);
  if (!wallet)
    throw new AppError(ApiErrorCode.NotFound, `Wallet not found: ${intent.fromWalletId}`);

  const lock = acquireExecution(intent.id);
  try {
    const current = requireIntent(db, intentId);
    if (current.status === IntentStatus.Confirmed || current.status === IntentStatus.Failed) {
      return { intent: current, txHash: current.txHash };
    }
    if (current.status === IntentStatus.Approved) return { intent: current };
    if (current.status !== IntentStatus.Broadcast) {
      throw new AppError(
        ApiErrorCode.InvalidStatus,
        `Intent ${intentId} is ${current.status}, expected ${IntentStatus.Broadcast}`,
      );
    }

    const signedRawTx = getIntentSignedRawTx(db, current.id);
    const txHash =
      current.txHash ?? (signedRawTx !== undefined ? keccak256(signedRawTx) : undefined);
    if (txHash === undefined) {
      unclaimIdleBroadcast(db, current.id, actorId, "transaction hash not yet available");
      return { intent: requireIntent(db, intentId) };
    }

    if (signedRawTx !== undefined && !hashesEqual(keccak256(signedRawTx), txHash)) {
      failMismatch(db, current.id, actorId, "stored raw tx does not match tx hash", txHash);
      return { intent: requireIntent(db, current.id), txHash };
    }

    if (signedRawTx !== undefined) {
      const decoded = await decodeSignedRawTx(signedRawTx);
      if (decoded === undefined || !txMatchesIntent(decoded, current, wallet.address)) {
        failMismatch(db, current.id, actorId, "stored raw tx does not match intent", txHash);
        return { intent: requireIntent(db, current.id), txHash };
      }
    }

    let tx: Awaited<ReturnType<typeof getTx>>;
    try {
      tx = await getTx(txHash);
    } catch (err) {
      if (!(err instanceof TransactionNotFoundError)) throw err;
      if (signedRawTx === undefined) {
        throw new AppError(ApiErrorCode.TxPending, "transaction not yet available");
      }

      let sentHash: Hex;
      try {
        sentHash = await broadcastSignedTx(signedRawTx);
      } catch (sendErr) {
        if (sendErr instanceof AppError) throw sendErr;
        try {
          await getTx(txHash);
        } catch (lookupErr) {
          if (lookupErr instanceof TransactionNotFoundError) {
            throw new AppError(ApiErrorCode.TxPending, "transaction not yet available");
          }
          throw lookupErr;
        }
        sentHash = txHash;
      }
      if (!hashesEqual(sentHash, txHash)) {
        throw new Error(`broadcast hash mismatch: expected ${txHash}, got ${sentHash}`);
      }
      appendAuditEvent(db, {
        type: AuditEventType.TxBroadcast,
        payload: { intentId: current.id, txHash },
        actor: actorId,
      });
      try {
        tx = await getTx(txHash);
      } catch (retryErr) {
        if (retryErr instanceof TransactionNotFoundError) {
          throw new AppError(ApiErrorCode.TxPending, "transaction not yet available");
        }
        throw retryErr;
      }
    }

    if (!txMatchesIntent(tx, current, wallet.address)) {
      failMismatch(db, current.id, actorId, "chain tx does not match intent", txHash);
      return { intent: requireIntent(db, current.id), txHash };
    }

    let receipt: Awaited<ReturnType<typeof getTxReceipt>>;
    try {
      receipt = await getTxReceipt(txHash);
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) {
        throw new AppError(ApiErrorCode.TxPending, "receipt not yet available");
      }
      throw err;
    }

    const failed = receipt.status !== "success";
    markBroadcastOutcome(db, {
      intentId: current.id,
      actorId,
      txHash,
      status: failed ? IntentStatus.Failed : IntentStatus.Confirmed,
      type: failed ? AuditEventType.TxFailed : AuditEventType.TxConfirmed,
      payload: {
        intentId: current.id,
        txHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        ...(failed ? { error: "receipt status is not success" } : {}),
      },
    });

    const latest = requireIntent(db, current.id);
    if (latest.status === IntentStatus.Confirmed) return { intent: latest, txHash };
    throw new AppError(ApiErrorCode.TxReverted, "receipt status is not success");
  } finally {
    releaseExecution(lock);
  }
}
