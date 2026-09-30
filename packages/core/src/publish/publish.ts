import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBatch } from '../batch/collect.js';
import { type Db, getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { assertWeek, madridDate } from '../pipeline/week.js';
import { atomicWriteFile } from '../vault/fsutil.js';
import { stripBom } from '../vault/markdown.js';
import { addCatalogRows } from './catalog.js';
import { renderReport } from './report.js';

export type PublishOptions = {
  repoDir: string;
  /** Carpeta del proyecto en el vault (`VAULT_PATH`). */
  vaultDir: string;
  week: string;
  now?: Date;
  /** Sobrescribir un informe ya marcado `revisado: true`. */
  force?: boolean;
  db?: Db;
};

export type PublishSummary = {
  reportFile: string;
  evaluated: number;
  published: number;
  catalogAdded: number;
  catalogSkipped: number;
};

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const frontmatterOf = (text: string) =>
  stripBom(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';

/**
 * `spf publish` (Plan §6.5): informe de la semana en `Informes/` y filas nuevas
 * en `Catalogo.md`. Valida el batch como `collect-batch`, sin reinsertar, y
 * calcula todo antes de escribir nada. Nunca toca la columna `estado`.
 */
export async function publishWeek(
  opts: PublishOptions,
): Promise<PublishSummary> {
  const { repoDir, vaultDir } = opts;
  const week = assertWeek(opts.week);
  const now = opts.now ?? new Date();
  const today = madridDate(now);

  const { scorings, candidates, interests } = await validateBatch({
    repoDir,
    week,
  });

  const reportFile = path.join(vaultDir, 'Informes', `${week}.md`);
  const previous = await readIfExists(reportFile);
  const previousFrontmatter = previous ? frontmatterOf(previous) : '';
  if (/^revisado:\s*true\s*$/m.test(previousFrontmatter) && !opts.force) {
    throw new Error(
      `Informes/${week}.md ya está revisado (revisado: true): no se sobrescribe. Usa --force si de verdad quieres regenerarlo.`,
    );
  }
  const created = previousFrontmatter.match(
    /^created:\s*(\d{4}-\d{2}-\d{2})\s*$/m,
  )?.[1];

  const report = renderReport({
    week,
    now,
    interests,
    file: candidates,
    scorings,
    created,
  });

  const catalogFile = path.join(vaultDir, 'Catalogo.md');
  const catalogText = await fs.readFile(catalogFile, 'utf8');
  const byId = new Map(candidates.candidates.map((c) => [c.id, c]));
  const rows = scorings
    .filter((s) => s.score >= interests.umbral_score)
    .sort(
      (a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId),
    )
    .flatMap((s) => {
      const c = byId.get(s.candidateId);
      return c
        ? [
            {
              nombre: c.name,
              tipo: c.kind,
              categoria: s.categoria,
              semana: week,
              score: s.score,
              nota: `${s.porQue} · [[${week}]]`,
              enlace: c.url,
            },
          ]
        : [];
    });
  const catalog = addCatalogRows(catalogText, rows, today);

  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await atomicWriteFile(reportFile, report);
  if (catalog.added.length > 0)
    await atomicWriteFile(catalogFile, catalog.text);

  const db = opts.db ?? getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  await db.insert(runs).values({
    id: crypto.randomUUID(),
    half: 'evaluate',
    week,
    trigger: 'manual',
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    stats: {
      scored: scorings.length,
      published: rows.length,
      catalogAdded: catalog.added.length,
      catalogSkipped: catalog.skipped.length,
    },
    errorsBySource: [],
  });

  return {
    reportFile,
    evaluated: scorings.length,
    published: rows.length,
    catalogAdded: catalog.added.length,
    catalogSkipped: catalog.skipped.length,
  };
}
