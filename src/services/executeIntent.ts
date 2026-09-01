import { appendAuditEvent } from "src/audit/log.js";
import { broadcastSignedTx, waitForTx } from "src/chain/broadcast.js";
import { buildTransferTx } from "src/chain/buildTransferTx.js";
import type { Db } from "src/db/client.js";
import {
  claimIntentForExecution,
  getIntent,
  isUniqueConstraintError,
  persistBroadcastSignature,
} from "src/db/intents.js";
import { getWallet } from "src/db/wallets.js";
import type { TransferIntent } from "src/domain/types.js";
import { ApiErrorCode, AuditEventType, IntentStatus } from "src/domain/types.js";
import {
  applyReceipt,
  decodeSignedRawTx,
  hashesEqual,
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
    const txHash = keccak256(signedTx);

    if (!persistBroadcastSignature(db, intentId, txHash, signedTx)) {
      throw new AppError(
        ApiErrorCode.InvalidStatus,
        `Intent ${intentId} is no longer claimed for execution`,
      );
    }
    signed = true;
    releaseExecution(lock);

    appendAuditEvent(db, {
      type: AuditEventType.SignRequested,
      payload: { intentId, txHash },
      actor: actorId,
    });

    const sentHash = await broadcastSignedTx(signedTx);
    if (!hashesEqual(sentHash, txHash)) {
      throw new Error(`broadcast hash mismatch: expected ${txHash}, got ${sentHash}`);
    }
    appendAuditEvent(db, {
      type: AuditEventType.TxBroadcast,
      payload: { intentId, txHash },
      actor: actorId,
    });

    const receipt = await waitForTx(txHash);
    const updated = applyReceipt(db, { intentId, actorId, txHash, receipt });
    return { intent: updated, txHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : "execute failed";
    if (claimed && !signed) unclaimIdleBroadcast(db, intentId, actorId, message);
    if (err instanceof AppError) throw err;
    throw new Error(message);
  } finally {
    releaseExecution(lock);
  }
}
