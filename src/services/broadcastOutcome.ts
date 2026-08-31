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

export function intentResult(intent: TransferIntent): { intent: TransferIntent; txHash?: Hex } {
  return intent.txHash !== undefined ? { intent, txHash: intent.txHash } : { intent };
}

export function hashesEqual(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function receiptError(status: string): string {
  return status === "reverted"
    ? "receipt status is not success"
    : `unexpected receipt status: ${status}`;
}

export function requireIntent(db: Db, intentId: string): TransferIntent {
  const intent = getIntent(db, intentId);
  if (!intent)
    throw new AppError(ApiErrorCode.NotFound, `Intent missing after update: ${intentId}`);
  return intent;
}

/** Release a claimed intent that never persisted a hash or raw. */
export function unclaimIdleBroadcast(
  db: Db,
  intentId: string,
  actorId: string,
  error: string,
): boolean {
  let unclaimed = false;
  db.transaction(() => {
    if (unclaimBroadcastIntent(db, intentId)) {
      appendAuditEvent(db, {
        type: AuditEventType.ExecutionAborted,
        payload: { intentId, error },
        actor: actorId,
      });
      unclaimed = true;
    }
  })();
  return unclaimed;
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
  const to = tx.to;
  return (
    to !== null &&
    to.toLowerCase() === intent.to.toLowerCase() &&
    tx.from.toLowerCase() === from.toLowerCase() &&
    tx.value === intent.value &&
    isEmptyInput(tx.input)
  );
}

function isEmptyInput(input: unknown): boolean {
  return typeof input === "string" && (input === "0x" || /^0x0+$/i.test(input));
}

/** Decode a stored raw tx for match checks. Returns undefined if it is not a signed transfer. */
export async function decodeSignedRawTx(signedRawTx: Hex): Promise<
  | {
      to: Address | null;
      from: Address;
      value: bigint;
      input: string;
    }
  | undefined
> {
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
  input: {
    intentId: string;
    actorId: string;
    error: string;
    txHash?: Hex;
    to?: string | null;
    from?: string;
    value?: string;
  },
): { intent: TransferIntent; txHash?: Hex } {
  db.transaction(() => {
    if (transitionBroadcastIntent(db, input.intentId, IntentStatus.Failed, input.txHash)) {
      appendAuditEvent(db, {
        type: AuditEventType.ReconcileMismatch,
        payload: {
          intentId: input.intentId,
          ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          error: input.error,
        },
        actor: input.actorId,
      });
    }
  })();
  const latest = requireIntent(db, input.intentId);
  if (latest.status === IntentStatus.Confirmed && hashesEqual(latest.txHash, input.txHash)) {
    return intentResult(latest);
  }
  throw new AppError(ApiErrorCode.ReconcileMismatch, input.error);
}
