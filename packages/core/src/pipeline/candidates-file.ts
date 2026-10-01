import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatZodError } from '../config/interests.js';
import { FILTER_RULES } from '../filter/index.js';
import { candidateSchema } from '../normalize/candidate.js';
import { atomicWriteFile } from '../vault/fsutil.js';
import { WEEK_PATTERN, assertWeek } from './week.js';

const count = z.number().int().nonnegative();

export const discardedEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
    regla: z.enum(FILTER_RULES),
    motivo: z.string().min(1),
  })
  .strict();

export const deferredEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().min(1),
    categoria: z.string().min(1),
    stars: count,
    motivo: z.string().min(1),
  })
  .strict();

/**
 * Recuento por etapa de una recogida (RF-10). `requests` y `cacheHits` son los de
 * las búsquedas (cuota `search`, 30 por minuto); `enrichRequests` y
 * `enrichCacheHits` son los del enrich (cuota `core`, 5.000 por hora). Son
 * opcionales porque los ficheros anteriores a que se contara el enrich no los tienen.
 */
export const runStatsSchema = z
  .object({
    queries: count,
    requests: count,
    cacheHits: count,
    enrichRequests: count.optional(),
    enrichCacheHits: count.optional(),
    rawItems: count,
    uniqueRepos: count,
    afterDedupe: count,
    afterRules: count,
    selected: count,
    deferred: count,
    enriched: count,
    /** Colector `awesome-list` (ausentes si no se ejecutó); las peticiones son del cubo `core`. */
    awesomeLists: count.optional(),
    awesomeRequests: count.optional(),
    /** READMEs que contestaron 304 gracias a la ETag. */
    awesomeNotModified: count.optional(),
    /** Enlaces nuevos respecto a la instantánea anterior. */
    awesomeNuevos: count.optional(),
    awesomeResueltos: count.optional(),
    /** Enlaces que vuelven la próxima semana (tope por lista o error transitorio). */
    awesomePendientes: count.optional(),
  })
  .strict();

export type RunStats = z.infer<typeof runStatsSchema>;

export const sourceErrorSchema = z
  .object({
    source: z.string().min(1),
    query: z.string().optional(),
    message: z.string(),
  })
  .strict();

export const runRecordSchema = z
  .object({
    at: z.string(),
    trigger: z.string().min(1),
    stats: runStatsSchema,
    errorsBySource: z.array(sourceErrorSchema),
  })
  .strict();

export type RunRecord = z.infer<typeof runRecordSchema>;

/** `data/candidates/YYYY-Www.json`: lo que la nube deja para la evaluación local. */
export const candidatesFileSchema = z
  .object({
    week: z.string().regex(WEEK_PATTERN),
    generatedAt: z.string(),
    /** Una entrada por ejecución de `spf collect` de esa semana. */
    runs: z.array(runRecordSchema),
    candidates: z.array(candidateSchema),
    descartados: z.array(discardedEntrySchema),
    diferidos: z.array(deferredEntrySchema),
  })
  .strict();

export type CandidatesFile = z.infer<typeof candidatesFileSchema>;

export const candidatesPath = (repoDir: string, week: string) =>
  path.join(repoDir, 'data', 'candidates', `${assertWeek(week)}.json`);

export async function readCandidatesFile(
  repoDir: string,
  week: string,
): Promise<CandidatesFile | null> {
  const file = candidatesPath(repoDir, week);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${file} no es JSON válido.`);
  }
  const parsed = candidatesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${file} no cumple el esquema: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function writeCandidatesFile(
  repoDir: string,
  file: CandidatesFile,
): Promise<string> {
  const target = candidatesPath(repoDir, file.week);
  const valid = candidatesFileSchema.parse(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteFile(target, `${JSON.stringify(valid, null, 2)}\n`);
  return target;
}

const byId = <T extends { id: string }>(items: T[]) =>
  new Map(items.map((item) => [item.id, item]));

/**
 * Fusiona una recogida con lo que ya hay de esa semana (p. ej. el cron del
 * lunes y una ejecución manual el miércoles). Los candidatos se acumulan y los
 * más recientes ganan; un descartado o diferido que ahora entra en el batch
 * deja de figurar como tal.
 */
export function mergeCandidatesFile(
  existing: CandidatesFile | null,
  incoming: {
    week: string;
    generatedAt: string;
    run: RunRecord;
    candidates: CandidatesFile['candidates'];
    descartados: CandidatesFile['descartados'];
    diferidos: CandidatesFile['diferidos'];
  },
): CandidatesFile {
  const candidates = byId([
    ...(existing?.candidates ?? []),
    ...incoming.candidates,
  ]);
  const notInBatch = <T extends { id: string }>(items: T[]) =>
    [...byId(items).values()].filter((item) => !candidates.has(item.id));

  return {
    week: incoming.week,
    generatedAt: incoming.generatedAt,
    runs: [...(existing?.runs ?? []), incoming.run],
    candidates: [...candidates.values()],
    descartados: notInBatch([
      ...(existing?.descartados ?? []),
      ...incoming.descartados,
    ]),
    diferidos: notInBatch([
      ...(existing?.diferidos ?? []),
      ...incoming.diferidos,
    ]),
  };
}
