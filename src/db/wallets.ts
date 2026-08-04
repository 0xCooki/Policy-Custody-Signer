import type { Db } from "src/db/client.js";
import type { Wallet } from "src/domain/types.js";
import type { Address } from "src/signers/types.js";

type WalletRow = {
  id: string;
  address: string;
  created_at: string;
};

function rowToWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    address: row.address as Address,
    createdAt: row.created_at,
  };
}

export function createWallet(
  db: Db,
  input: { id: string; address: Address; createdAt: string },
): Wallet {
  db.prepare(`INSERT INTO wallets (id, address, created_at) VALUES (?, ?, ?)`).run(
    input.id,
    input.address,
    input.createdAt,
  );

  return { ...input };
}

export function getWallet(db: Db, id: string): Wallet | undefined {
  const row = db.prepare(`SELECT id, address, created_at FROM wallets WHERE id = ?`).get(id) as
    | WalletRow
    | undefined;

  return row ? rowToWallet(row) : undefined;
}

export function listWallets(db: Db): Wallet[] {
  const rows = db
    .prepare(`SELECT id, address, created_at FROM wallets ORDER BY created_at ASC`)
    .all() as WalletRow[];

  return rows.map(rowToWallet);
}
