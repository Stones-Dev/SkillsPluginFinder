import crypto from 'node:crypto';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  createGithubClient,
  requireToken,
} from '../collectors/github-client.js';
import { SOURCE_ID, collectFromGithub } from '../collectors/github.js';
import { loadCatalog, loadInterests } from '../config/interests.js';
import { type Db, getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { applyEnrichment, enrichGithubRepo } from '../enrich/github.js';
import { filterCandidates } from '../filter/index.js';
import {
  dedupeCandidates,
  markAsSeen,
  normalizeGithubRepo,
} from '../normalize/index.js';
import {
  type RunRecord,
  type RunStats,
  mergeCandidatesFile,
  readCandidatesFile,
  writeCandidatesFile,
} from './candidates-file.js';
import { selectForEnrichment } from './quota.js';
import { isoWeek } from './week.js';

const ENRICH_CONCURRENCY = 4;

export type CollectOptions = {
  repoDir: string;
  token: string | undefined;
  source?: string;
  now?: Date;
  /** `schedule` | `workflow_dispatch` (Actions) o `manual`. */
  trigger?: string;
  logger?: (message: string) => void;
  db?: Db;
  /** Solo tests. */
  throttle?: boolean;
  retryBaseMs?: number;
};

export type CollectSummary = {
  week: string;
  file: string;
  run: RunRecord;
  /** Candidatos en el fichero de la semana tras fusionar con recogidas anteriores. */
  totalCandidates: number;
};

/**
 * Mitad nube (Plan §5): espejos del repo → colector → normalize → dedupe →
 * reglas → tope `enrich_max` → enrich → `data/candidates/YYYY-Www.json`. Sin IA
 * y sin acceso al vault. Solo se marcan como vistos los candidatos que entran
 * al batch: lo descartado por reglas se reevalúa cada semana y lo diferido por
 * el tope puede volver.
 */
export async function collectWeek(
  options: CollectOptions,
): Promise<CollectSummary> {
  const { repoDir, logger } = options;
  if (options.source && options.source !== SOURCE_ID) {
    throw new Error(
      `Fuente no soportada: ${options.source} (solo ${SOURCE_ID})`,
    );
  }
  // Antes de leer o escribir nada: sin token no se hace ningún trabajo a medias.
  const token = requireToken(options.token);

  const now = options.now ?? new Date();
  const week = isoWeek(now);
  const interests = await loadInterests(repoDir);
  const catalog = await loadCatalog(repoDir);
  const db = options.db ?? getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  const cacheDir = path.join(repoDir, 'data', 'cache', 'github');
  const client = {
    cacheDir,
    logger,
    throttle: options.throttle,
    retryBaseMs: options.retryBaseMs,
  };

  const search = await collectFromGithub({
    token,
    interests,
    now,
    ...client,
  });
  const failedQueries = search.errors.filter((e) => e.query).length;
  if (search.stats.executed > 0 && failedQueries === search.stats.executed) {
    throw new Error(
      `Todas las consultas de ${SOURCE_ID} fallaron (${search.errors[0].message}); no se escribe nada.`,
    );
  }

  const normalized = search.repos.map((r) =>
    normalizeGithubRepo(r, { interests, now }),
  );
  const fresh = await dedupeCandidates(normalized, db);
  const { kept, descartados } = filterCandidates(
    fresh,
    interests,
    catalog,
    now,
  );
  const { selected, deferred } = selectForEnrichment(kept, interests, now);

  const { octokit, stats: enrichStats } = createGithubClient({
    token,
    ...client,
  });
  const limit = pLimit(ENRICH_CONCURRENCY);
  let done = 0;
  const enriched = await Promise.all(
    selected.map((candidate) =>
      limit(async () => {
        const result = applyEnrichment(
          candidate,
          await enrichGithubRepo(octokit, candidate.name),
        );
        logger?.(`enrich ${++done}/${selected.length}: ${candidate.name}`);
        return result;
      }),
    ),
  );

  const stats: RunStats = {
    queries: search.stats.queries,
    requests: search.stats.requests,
    cacheHits: search.stats.cacheHits,
    enrichRequests: enrichStats.requests,
    enrichCacheHits: enrichStats.cacheHits,
    rawItems: search.stats.rawItems,
    uniqueRepos: search.stats.uniqueRepos,
    afterDedupe: fresh.length,
    afterRules: kept.length,
    selected: selected.length,
    deferred: deferred.length,
    enriched: enriched.length,
  };
  const run: RunRecord = {
    at: now.toISOString(),
    trigger: options.trigger ?? 'manual',
    stats,
    errorsBySource: search.errors,
  };

  const merged = mergeCandidatesFile(await readCandidatesFile(repoDir, week), {
    week,
    generatedAt: now.toISOString(),
    run,
    candidates: enriched,
    descartados: descartados.map((d) => ({
      id: d.candidate.id,
      name: d.candidate.name,
      url: d.candidate.url,
      regla: d.regla,
      motivo: d.motivo,
    })),
    diferidos: deferred,
  });
  const file = await writeCandidatesFile(repoDir, merged);

  await markAsSeen(
    enriched.map((c) => c.id),
    db,
  );
  await db.insert(runs).values({
    id: crypto.randomUUID(),
    half: 'collect',
    week,
    trigger: run.trigger,
    startedAt: run.at,
    finishedAt: new Date().toISOString(),
    stats,
    errorsBySource: run.errorsBySource,
  });

  return { week, file, run, totalCandidates: merged.candidates.length };
}
