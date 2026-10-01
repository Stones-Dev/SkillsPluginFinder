import crypto from 'node:crypto';
import path from 'node:path';
import { type Db, getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { assertWeek } from '../pipeline/week.js';
import { type ValidatedBatch, collectBatch } from './collect.js';

export type AntigravityOutcome =
  | { ok: true; validated: ValidatedBatch }
  | { ok: false; error: string };

const MAX_ERROR = 600;

/**
 * Valida y guarda `scoring-antigravity.json`, el segundo evaluador (Plan §7 bis).
 * A diferencia del de Claude Code, un fallo aquí no es fatal: se anota en `runs`
 * (con la causa que dé el wrapper en `reason`, p. ej. «agy agotó el tiempo») y la
 * semana sigue solo con la evaluación de Claude Code.
 */
export async function collectAntigravity(opts: {
  repoDir: string;
  week: string;
  /** Por qué falló el wrapper de `agy`, si ya se sabe antes de validar nada. */
  reason?: string;
  now?: Date;
  db?: Db;
}): Promise<AntigravityOutcome> {
  const week = assertWeek(opts.week);
  const started = opts.now ?? new Date();
  const db = opts.db ?? getDb(path.join(opts.repoDir, 'data', 'seen.sqlite'));

  try {
    if (opts.reason) throw new Error(opts.reason);
    const validated = await collectBatch({
      repoDir: opts.repoDir,
      week,
      agent: 'antigravity',
      db,
    });
    return { ok: true, validated };
  } catch (err) {
    const message = (err as Error).message.replace(/\s+/g, ' ').trim();
    const error =
      message.length > MAX_ERROR
        ? `${message.slice(0, MAX_ERROR - 1)}…`
        : message;
    await db.insert(runs).values({
      id: crypto.randomUUID(),
      half: 'evaluate',
      week,
      trigger: 'antigravity',
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      stats: { scored: 0, antigravity: 0 },
      errorsBySource: [{ source: 'antigravity', message: error }],
    });
    return { ok: false, error };
  }
}
