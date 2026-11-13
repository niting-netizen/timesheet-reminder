import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded through require so bundlers (Vitest/Vite) leave the built-in alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSyncType;

/** Ordered migrations. Never edit a shipped entry; append a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE secrets (
    ref TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE TABLE connection_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    message TEXT NOT NULL,
    tested_at TEXT NOT NULL,
    tested_by TEXT NOT NULL
  );
  CREATE INDEX ix_connection_tests_target ON connection_tests (target, id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  );
  CREATE TABLE employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    team TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE source_accounts (
    employee_id INTEGER NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    PRIMARY KEY (employee_id, source),
    UNIQUE (source, external_user_id)
  );
  `,
  `
  CREATE TABLE worklogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    issue_key TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    work_date TEXT NOT NULL,
    seconds INTEGER NOT NULL,
    origin TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE INDEX ix_worklogs_date ON worklogs (work_date, source);
  CREATE INDEX ix_worklogs_user ON worklogs (source, external_user_id);
  CREATE TABLE source_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    rows INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    imported_by TEXT NOT NULL
  );
  CREATE TABLE check_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX ix_check_runs_week ON check_runs (week_start, id);
  CREATE TABLE weekly_timesheets (
    employee_id INTEGER NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    logged_seconds INTEGER NOT NULL,
    target_seconds INTEGER NOT NULL,
    pending_seconds INTEGER NOT NULL,
    completion_pct REAL NOT NULL,
    status TEXT NOT NULL,
    by_source TEXT NOT NULL DEFAULT '{}',
    days_off REAL NOT NULL DEFAULT 0,
    run_id INTEGER NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (employee_id, week_start)
  );
  CREATE TABLE calendar_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER REFERENCES employees (id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    hours REAL,
    approved INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE INDEX ix_adjustments_date ON calendar_adjustments (date);
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();
