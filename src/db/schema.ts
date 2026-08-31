import type { Db } from "src/db/client.js";
import { IntentStatus } from "src/domain/types.js";

export function migrate(db: Db): void {
  db.exec(`
        CREATE TABLE IF NOT EXISTS wallets (
            id TEXT PRIMARY KEY NOT NULL,
            address TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS intents (
            id TEXT PRIMARY KEY NOT NULL,
            from_wallet_id TEXT NOT NULL,
            to_address TEXT NOT NULL,
            value TEXT NOT NULL,
            asset TEXT NOT NULL,
            initiator_id TEXT NOT NULL,
            status TEXT NOT NULL,
            tx_hash TEXT,
            signed_raw_tx TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY NOT NULL,
            intent_id TEXT NOT NULL,
            approver_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (intent_id, approver_id)
        );

        CREATE TABLE IF NOT EXISTS audit_events (
            id TEXT PRIMARY KEY NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            actor TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            prev_hash TEXT,
            event_hash TEXT NOT NULL
        );
    `);

  addColumnIfMissing(db, "intents", "signed_raw_tx", "TEXT");
  assertAtMostOneBroadcastPerWallet(db);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS intents_one_broadcast_per_wallet
    ON intents(from_wallet_id)
    WHERE status = 'broadcast';
  `);
}

function addColumnIfMissing(db: Db, table: string, column: string, spec: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
}

function assertAtMostOneBroadcastPerWallet(db: Db): void {
  const rows = db
    .prepare(
      `SELECT from_wallet_id AS fromWalletId, COUNT(*) AS n
       FROM intents
       WHERE status = ?
       GROUP BY from_wallet_id
       HAVING COUNT(*) > 1`,
    )
    .all(IntentStatus.Broadcast) as { fromWalletId: string; n: number }[];
  if (rows.length === 0) return;
  const wallets = rows.map((row) => `${row.fromWalletId} (${row.n})`).join(", ");
  throw new Error(
    `Cannot create unique index intents_one_broadcast_per_wallet: multiple broadcast intents for wallet(s): ${wallets}`,
  );
}
