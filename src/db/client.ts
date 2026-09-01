import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { config } from "src/config.js";
import { migrate } from "src/db/schema.js";

export type Db = Database.Database;

export function openDb(databasePath = config.databasePath): Db {
  const dir = path.dirname(databasePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(databasePath);

  db.pragma("journal_mode = WAL");

  migrate(db);
  return db;
}
