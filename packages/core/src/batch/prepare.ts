import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCatalog, loadInterests } from '../config/interests.js';
import { readCandidatesFile } from '../pipeline/candidates-file.js';
import { assertWeek } from '../pipeline/week.js';
import { atomicWriteFile } from '../vault/fsutil.js';
import { batchDir } from './collect.js';
import { renderBatch } from './render.js';

export type PrepareSummary = {
  file: string;
  candidates: number;
  /** Nº de fichas por categoría sugerida. */
  categories: Record<string, number>;
  /** Ya había un `scoring.json` de esta semana: `prepare` nunca lo toca. */
  scoringExists: boolean;
};

/**
 * `spf prepare`: `data/candidates/<week>.json` + espejos del repo →
 * `data/batches/<week>/batch.md`. No recoge nada de la red: la recogida es
 * `spf collect`. Regenerar el batch no toca un `scoring.json` existente.
 */
export async function prepareBatch(opts: {
  repoDir: string;
  week: string;
}): Promise<PrepareSummary> {
  const { repoDir } = opts;
  const week = assertWeek(opts.week);

  const file = await readCandidatesFile(repoDir, week);
  if (!file) {
    throw new Error(
      `No existe data/candidates/${week}.json: ejecuta "pnpm spf collect" antes de preparar el batch.`,
    );
  }
  const interests = await loadInterests(repoDir);
  const catalog = await loadCatalog(repoDir);

  const dir = batchDir(repoDir, week);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'batch.md');
  await atomicWriteFile(
    target,
    renderBatch({
      week,
      generatedAt: file.generatedAt,
      interests,
      catalog,
      candidates: file.candidates,
    }),
  );

  const categories: Record<string, number> = {};
  for (const c of file.candidates) {
    categories[c.categoriaSugerida] =
      (categories[c.categoriaSugerida] ?? 0) + 1;
  }
  const scoringExists = await fs
    .access(path.join(dir, 'scoring.json'))
    .then(() => true)
    .catch(() => false);

  return {
    file: target,
    candidates: file.candidates.length,
    categories,
    scoringExists,
  };
}
