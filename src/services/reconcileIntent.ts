import { appendAuditEvent } from "src/audit/log.js";
import { broadcastSignedTx, getTx, getTxReceipt } from "src/chain/broadcast.js";
import { listAuditEventsForIntent } from "src/db/audit.js";
import type { Db } from "src/db/client.js";
import { getIntent, getIntentSignedRawTx } from "src/db/intents.js";
import { getWallet } from "src/db/wallets.js";
import type { TransferIntent } from "src/domain/types.js";
import { ApiErrorCode, AuditEventType, IntentStatus } from "src/domain/types.js";
import {
  decodeSignedRawTx,
  failMismatch,
  hashesEqual,
  intentResult,
  markBroadcastOutcome,
  receiptError,
  requireIntent,
  txMatchesIntent,
  unclaimIdleBroadcast,
} from "src/services/broadcastOutcome.js";
import { acquireExecution, releaseExecution } from "src/services/executionLock.js";
import type { Address, Hex } from "src/signers/types.js";
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
    return intentResult(intent);
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
    return await reconcileBroadcast(db, intent.id, actorId, wallet.address);
  } finally {
    releaseExecution(lock);
  }
}

async function reconcileBroadcast(
  db: Db,
  intentId: string,
  actorId: string,
  from: Address,
): Promise<{ intent: TransferIntent; txHash?: Hex }> {
  let intent = requireIntent(db, intentId);
  if (intent.status === IntentStatus.Confirmed || intent.status === IntentStatus.Failed) {
    return intentResult(intent);
  }
  if (intent.status === IntentStatus.Approved) {
    return { intent };
  }
  if (intent.status !== IntentStatus.Broadcast) {
    throw new AppError(
      ApiErrorCode.InvalidStatus,
      `Intent ${intentId} is ${intent.status}, expected ${IntentStatus.Broadcast}`,
    );
  }

  let signedRawTx = getIntentSignedRawTx(db, intent.id);
  let txHash = intent.txHash ?? hashFromRaw(signedRawTx);

  if (txHash === undefined) {
    unclaimIdleBroadcast(db, intent.id, actorId, "transaction hash not yet available");
    intent = requireIntent(db, intentId);
    if (intent.status !== IntentStatus.Broadcast) return intentResult(intent);
    signedRawTx = getIntentSignedRawTx(db, intent.id);
    txHash = intent.txHash ?? hashFromRaw(signedRawTx);
    if (txHash === undefined) {
      throw new AppError(ApiErrorCode.TxPending, "transaction hash not yet available");
    }
  }

  if (signedRawTx !== undefined && !hashesEqual(keccak256(signedRawTx), txHash)) {
    return failMismatch(db, {
      intentId: intent.id,
      actorId,
      txHash,
      error: "stored raw tx does not match tx hash",
    });
  }

  const localMatch = await signedRawMatchesIntent(signedRawTx, intent, from);
  if (signedRawTx !== undefined && !localMatch) {
    return failMismatch(db, {
      intentId: intent.id,
      actorId,
      txHash,
      error: "stored raw tx does not match intent",
    });
  }

  const { receipt, tx } = await loadChainTx(db, {
    intentId: intent.id,
    actorId,
    txHash,
    signedRawTx,
    intent,
    from,
  });

  // Local raw already matched: do not fail-closed on a lying getTx.
  if (!localMatch && !txMatchesIntent(tx, intent, from)) {
    return failMismatch(db, {
      intentId: intent.id,
      actorId,
      txHash,
      error: "chain tx does not match intent",
      to: tx.to ?? null,
      from: tx.from,
      value: tx.value.toString(),
    });
  }

  if (receipt.status !== "success") {
    markBroadcastOutcome(db, {
      intentId: intent.id,
      actorId,
      txHash,
      status: IntentStatus.Failed,
      type: AuditEventType.TxFailed,
      payload: {
        intentId: intent.id,
        txHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber.toString(),
        error: receiptError(receipt.status),
      },
    });
    const latest = requireIntent(db, intent.id);
    if (latest.status === IntentStatus.Confirmed && hashesEqual(latest.txHash, txHash)) {
      return { intent: latest, txHash };
    }
    throw new AppError(ApiErrorCode.TxReverted, receiptError(receipt.status));
  }

  markBroadcastOutcome(db, {
    intentId: intent.id,
    actorId,
    txHash,
    status: IntentStatus.Confirmed,
    type: AuditEventType.TxConfirmed,
    payload: {
      intentId: intent.id,
      txHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
    },
  });

  const confirmed = requireIntent(db, intent.id);
  if (confirmed.status === IntentStatus.Confirmed && hashesEqual(confirmed.txHash, txHash)) {
    return { intent: confirmed, txHash };
  }
  if (confirmed.status === IntentStatus.Failed) {
    throw new AppError(ApiErrorCode.TxReverted, "receipt status is not success");
  }
  throw new AppError(
    ApiErrorCode.InvalidStatus,
    `Intent ${intent.id} is ${confirmed.status}, expected ${IntentStatus.Confirmed}`,
  );
}

async function loadChainTx(
  db: Db,
  input: {
    intentId: string;
    actorId: string;
    txHash: Hex;
    signedRawTx: Hex | undefined;
    intent: TransferIntent;
    from: Address;
  },
) {
  let tx: Awaited<ReturnType<typeof getTx>>;
  try {
    tx = await getTx(input.txHash);
  } catch (err) {
    if (!(err instanceof TransactionNotFoundError)) throw err;
    await rebroadcastIfPossible(db, input);
    try {
      tx = await getTx(input.txHash);
    } catch (retryErr) {
      if (retryErr instanceof TransactionNotFoundError) {
        throw new AppError(ApiErrorCode.TxPending, "transaction not yet available");
      }
      throw retryErr;
    }
  }

  let receipt: Awaited<ReturnType<typeof getTxReceipt>>;
  try {
    receipt = await getTxReceipt(input.txHash);
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) {
      throw new AppError(ApiErrorCode.TxPending, "receipt not yet available");
    }
    throw err;
  }

  return { tx, receipt };
}

async function rebroadcastIfPossible(
  db: Db,
  input: {
    intentId: string;
    actorId: string;
    txHash: Hex;
    signedRawTx: Hex | undefined;
    intent: TransferIntent;
    from: Address;
  },
): Promise<void> {
  if (input.signedRawTx === undefined) {
    throw new AppError(ApiErrorCode.TxPending, "transaction not yet available");
  }

  const decoded = await decodeSignedRawTx(input.signedRawTx);
  if (decoded === undefined || !txMatchesIntent(decoded, input.intent, input.from)) {
    failMismatch(db, {
      intentId: input.intentId,
      actorId: input.actorId,
      txHash: input.txHash,
      error:
        decoded === undefined
          ? "stored raw tx is not a valid transfer"
          : "stored raw tx does not match intent",
      ...(decoded !== undefined
        ? { to: decoded.to, from: decoded.from, value: decoded.value.toString() }
        : {}),
    });
    return;
  }

  let sentHash: Hex;
  try {
    sentHash = await broadcastSignedTx(input.signedRawTx);
  } catch (err) {
    if (err instanceof AppError) throw err;
    try {
      await getTx(input.txHash);
    } catch (lookupErr) {
      if (lookupErr instanceof TransactionNotFoundError) {
        throw new AppError(ApiErrorCode.TxPending, "transaction not yet available");
      }
      throw lookupErr;
    }
    sentHash = input.txHash;
  }
  if (!hashesEqual(sentHash, input.txHash)) {
    throw new Error(`broadcast hash mismatch: expected ${input.txHash}, got ${sentHash}`);
  }

  recordBroadcast(db, input.intentId, input.actorId, input.txHash);
}

function recordBroadcast(db: Db, intentId: string, actorId: string, txHash: Hex): void {
  const alreadyLogged = listAuditEventsForIntent(db, intentId).some(
    (event) =>
      event.type === AuditEventType.TxBroadcast &&
      typeof event.payload.txHash === "string" &&
      hashesEqual(event.payload.txHash, txHash),
  );
  if (alreadyLogged) return;
  appendAuditEvent(db, {
    type: AuditEventType.TxBroadcast,
    payload: { intentId, txHash },
    actor: actorId,
  });
}

function hashFromRaw(signedRawTx: Hex | undefined): Hex | undefined {
  return signedRawTx === undefined ? undefined : keccak256(signedRawTx);
}

async function signedRawMatchesIntent(
  signedRawTx: Hex | undefined,
  intent: TransferIntent,
  from: Address,
): Promise<boolean> {
  if (signedRawTx === undefined) return false;
  const decoded = await decodeSignedRawTx(signedRawTx);
  return decoded !== undefined && txMatchesIntent(decoded, intent, from);
}
