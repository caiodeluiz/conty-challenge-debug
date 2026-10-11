import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  deadline_date TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_brl REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL UNIQUE,
  provider_status TEXT,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_mission_id_lookup
  ON ledger (mission_id);
CREATE INDEX IF NOT EXISTS ledger_idempotency_key_lookup
  ON ledger (idempotency_key);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
