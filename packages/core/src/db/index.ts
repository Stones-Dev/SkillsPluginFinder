import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  type BetterSQLite3Database,
  drizzle,
} from 'drizzle-orm/better-sqlite3';
import { repoRoot } from '../paths.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

const connections = new Map<string, { db: Db; sqlite: Database.Database }>();

/** Cierra todas las conexiones abiertas (tests y cierre limpio del CLI). */
export function closeDatabases() {
  for (const { sqlite } of connections.values()) sqlite.close();
  connections.clear();
}

export function getDb(
  dbPath = path.join(repoRoot(), 'data', 'seen.sqlite'),
): Db {
  const cached = connections.get(dbPath);
  if (cached) return cached.db;

  let sqlite: Database.Database;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    sqlite = new Database(dbPath);
  } catch (err) {
    throw new Error(
      `No se pudo abrir SQLite en ${dbPath}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      language TEXT,
      stars INTEGER,
      forks INTEGER,
      created_at TEXT,
      topics TEXT,
      categoria_sugerida TEXT
    );
    CREATE TABLE IF NOT EXISTS scorings (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      week TEXT NOT NULL,
      agent TEXT NOT NULL,
      score REAL NOT NULL,
      categoria TEXT NOT NULL,
      proyectos_afectados TEXT,
      por_que TEXT NOT NULL,
      como_integrar TEXT NOT NULL,
      riesgos TEXT,
      uso_browser INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seen (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      half TEXT NOT NULL,
      week TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      stats TEXT NOT NULL,
      errors_by_source TEXT NOT NULL
    );
  `);

  const db = drizzle(sqlite, { schema });
  connections.set(dbPath, { db, sqlite });
  return db;
}
