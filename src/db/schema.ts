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

        CREATE UNIQUE INDEX IF NOT EXISTS intents_one_broadcast_per_wallet
        ON intents(from_wallet_id)
        WHERE status = 'broadcast';
    `);
}
