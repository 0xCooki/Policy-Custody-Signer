import type { Db } from "src/db/client.js";
import type { IntentStatus, TransferIntent } from "src/domain/types.js";
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
    asset: row.asset as "ETH",
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
    asset: "ETH";
    initiatorId: string;
    status: IntentStatus;
    createdAt: string;
  },
): TransferIntent {
  db.prepare(
    `INSERT INTO intents (
      id, from_wallet_id, to_address, value, asset,
      initiator_id, status, tx_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
  const row = db.prepare(`SELECT * FROM intents WHERE id = ?`).get(id) as IntentRow | undefined;
  return row ? rowToIntent(row) : undefined;
}

export function updateIntentExecution(db: Db, id: string, status: IntentStatus, txHash: Hex): void {
  db.prepare(`UPDATE intents SET status = ?, tx_hash = ? WHERE id = ?`).run(status, txHash, id);
}
