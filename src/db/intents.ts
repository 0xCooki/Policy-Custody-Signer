import type { Db } from "src/db/client.js";
import { type Asset, IntentStatus, type TransferIntent } from "src/domain/types.js";
import type { Address, Hex } from "src/signers/types.js";

type IntentRow = {
  id: string;
  from_wallet_id: string;
  to_address: string;
  value: string;
  asset: string;
  initiator_id: string;
  status: string;
  tx_hash: string | null;
  created_at: string;
};

function rowToIntent(row: IntentRow): TransferIntent {
  return {
    id: row.id,
    fromWalletId: row.from_wallet_id,
    to: row.to_address as Address,
    value: BigInt(row.value),
    asset: row.asset as Asset,
    initiatorId: row.initiator_id,
    status: row.status as IntentStatus,
    txHash: (row.tx_hash as Hex | null) ?? undefined,
    createdAt: row.created_at,
  };
}

export function createIntent(
  db: Db,
  input: {
    id: string;
    fromWalletId: string;
    to: Address;
    value: bigint;
    asset: Asset;
    initiatorId: string;
    status: IntentStatus;
    createdAt: string;
  },
): TransferIntent {
  db.prepare(
    `INSERT INTO intents (
      id, from_wallet_id, to_address, value, asset,
      initiator_id, status, tx_hash, signed_raw_tx, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    input.id,
    input.fromWalletId,
    input.to,
    input.value.toString(),
    input.asset,
    input.initiatorId,
    input.status,
    input.createdAt,
  );
  return { ...input, txHash: undefined };
}

export function getIntent(db: Db, id: string): TransferIntent | undefined {
  const row = db
    .prepare(
      `SELECT id, from_wallet_id, to_address, value, asset,
              initiator_id, status, tx_hash, created_at
       FROM intents WHERE id = ?`,
    )
    .get(id) as IntentRow | undefined;
  return row ? rowToIntent(row) : undefined;
}

export function updateIntentExecution(db: Db, id: string, status: IntentStatus, txHash: Hex): void {
  db.prepare(`UPDATE intents SET status = ?, tx_hash = ? WHERE id = ?`).run(status, txHash, id);
}

export function getIntentSignedRawTx(db: Db, id: string): Hex | undefined {
  const row = db.prepare(`SELECT signed_raw_tx FROM intents WHERE id = ?`).get(id) as
    | { signed_raw_tx: string | null }
    | undefined;
  return (row?.signed_raw_tx as Hex | null) ?? undefined;
}

export function updateIntentStatus(db: Db, id: string, status: IntentStatus): void {
  db.prepare(`UPDATE intents SET status = ? WHERE id = ?`).run(status, id);
}

export function claimIntentForExecution(db: Db, id: string): boolean {
  const result = db
    .prepare(`UPDATE intents SET status = ? WHERE id = ? AND status = ?`)
    .run(IntentStatus.Broadcast, id, IntentStatus.Approved);
  return result.changes === 1;
}

export function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function unclaimBroadcastIntent(db: Db, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE intents SET status = ? WHERE id = ? AND status = ? AND tx_hash IS NULL AND signed_raw_tx IS NULL`,
    )
    .run(IntentStatus.Approved, id, IntentStatus.Broadcast);
  return result.changes === 1;
}

export function persistBroadcastSignature(
  db: Db,
  id: string,
  txHash: Hex,
  signedRawTx: Hex,
): boolean {
  const result = db
    .prepare(
      `UPDATE intents SET tx_hash = ?, signed_raw_tx = ?
       WHERE id = ? AND status = ? AND tx_hash IS NULL AND signed_raw_tx IS NULL`,
    )
    .run(txHash, signedRawTx, id, IntentStatus.Broadcast);
  return result.changes === 1;
}

export function transitionBroadcastIntent(
  db: Db,
  id: string,
  status: IntentStatus,
  txHash: Hex,
): boolean {
  const result = db
    .prepare(
      `UPDATE intents SET status = ?, tx_hash = ?, signed_raw_tx = NULL WHERE id = ? AND status = ?`,
    )
    .run(status, txHash, id, IntentStatus.Broadcast);
  return result.changes === 1;
}
