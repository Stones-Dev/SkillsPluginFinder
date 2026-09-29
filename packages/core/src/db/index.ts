import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

let db: any;

export function getDb(dbPath = 'spf.db') {
  if (!db) {
    try {
      const sqlite = new Database(dbPath);
      db = drizzle(sqlite, { schema });
      
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
        CREATE TABLE IF NOT EXISTS seen (
          id TEXT PRIMARY KEY,
          dedupe_key TEXT NOT NULL UNIQUE
        );
      `);
    } catch (err) {
      console.warn("Could not load better-sqlite3 bindings, falling back to mock DB");
      const mockTable: any[] = [];
      db = {
        select: () => ({ from: () => ({ where: () => [] }) }),
        insert: () => ({ values: (v: any) => ({ onConflictDoNothing: async () => { mockTable.push(v); } }) })
      };
    }
  }
  return db;
}
