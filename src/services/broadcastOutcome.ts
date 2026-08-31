import { appendAuditEvent } from "src/audit/log.js";
import type { Db } from "src/db/client.js";
import { getIntent, transitionBroadcastIntent, unclaimBroadcastIntent } from "src/db/intents.js";
import {
  ApiErrorCode,
  AuditEventType,
  IntentStatus,
  type TransferIntent,
} from "src/domain/types.js";
import type { Address, Hex } from "src/signers/types.js";
import { AppError } from "src/utils/errors.js";
import { parseTransaction, recoverTransactionAddress, type TransactionSerialized } from "viem";

export function hashesEqual(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function requireIntent(db: Db, intentId: string): TransferIntent {
  const intent = getIntent(db, intentId);
  if (!intent)
    throw new AppError(ApiErrorCode.NotFound, `Intent missing after update: ${intentId}`);
  return intent;
}

export function unclaimIdleBroadcast(
  db: Db,
  intentId: string,
  actorId: string,
  error: string,
): void {
  db.transaction(() => {
    if (unclaimBroadcastIntent(db, intentId)) {
      appendAuditEvent(db, {
        type: AuditEventType.ExecutionAborted,
        payload: { intentId, error },
        actor: actorId,
      });
    }
  })();
}

export function markBroadcastOutcome(
  db: Db,
  input: {
    intentId: string;
    actorId: string;
    txHash: Hex;
    status: IntentStatus;
    type: AuditEventType;
    payload: Record<string, unknown>;
  },
): void {
  db.transaction(() => {
    if (transitionBroadcastIntent(db, input.intentId, input.status, input.txHash)) {
      appendAuditEvent(db, {
        type: input.type,
        payload: input.payload,
        actor: input.actorId,
      });
    }
  })();
}

export function txMatchesIntent(
  tx: { to: Address | null; from: Address; value: bigint; input: unknown },
  intent: TransferIntent,
  from: Address,
): boolean {
  return (
    tx.to !== null &&
    tx.to.toLowerCase() === intent.to.toLowerCase() &&
    tx.from.toLowerCase() === from.toLowerCase() &&
    tx.value === intent.value &&
    tx.input === "0x"
  );
}

export async function decodeSignedRawTx(
  signedRawTx: Hex,
): Promise<{ to: Address | null; from: Address; value: bigint; input: string } | undefined> {
  try {
    const parsed = parseTransaction(signedRawTx);
    const from = await recoverTransactionAddress({
      serializedTransaction: signedRawTx as TransactionSerialized,
    });
    return {
      to: parsed.to ?? null,
      from,
      value: parsed.value ?? 0n,
      input: parsed.data ?? "0x",
    };
  } catch {
    return undefined;
  }
}

export function failMismatch(
  db: Db,
  intentId: string,
  actorId: string,
  error: string,
  txHash: Hex,
): never {
  db.transaction(() => {
    if (transitionBroadcastIntent(db, intentId, IntentStatus.Failed, txHash)) {
      appendAuditEvent(db, {
        type: AuditEventType.ReconcileMismatch,
        payload: { intentId, txHash, error },
        actor: actorId,
      });
    }
  })();
  throw new AppError(ApiErrorCode.ReconcileMismatch, error);
}
