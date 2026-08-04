import type { Db } from "src/db/client.js";

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
            created_at TEXT NOT NULL
        );
    `);
}
