// Single SQLite connection (Node's built-in node:sqlite). Tables are created on startup.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DIR, { recursive: true });

export const DB_FILE = path.join(DIR, "tailorcv.sqlite");
export const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at);
  CREATE TABLE IF NOT EXISTS codes (
    code       TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    credits    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data       TEXT NOT NULL
  );
`);
