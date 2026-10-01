import crypto from 'node:crypto';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  createGithubClient,
  requireToken,
} from '../collectors/github-client.js';
import {
  SOURCE_ID,
  type SourceError,
  collectFromGithub,
} from '../collectors/github.js';
import { loadCatalog, loadInterests } from '../config/interests.js';
import { type Db, getDb, getReadonlyDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { applyEnrichment, enrichGithubRepo } from '../enrich/github.js';
import { type FilterRule, filterCandidates } from '../filter/index.js';
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
  /**
   * Ensayo: colector, normalize, dedupe (solo lectura), reglas y tope, con resumen,
   * **sin escribir nada**: ni `data/candidates/`, ni `seen.sqlite`, ni `runs`, ni la
   * caché HTTP de `data/cache/`. Tampoco enriquece (gastaría ~3 peticiones `core`
   * por repo). Sí gasta las peticiones de búsqueda.
   */
  dryRun?: boolean;
  /** Solo tests. */
  throttle?: boolean;
  retryBaseMs?: number;
};

/** Lo que dice `spf collect --dry-run`. */
export type DryRunSummary = {
  dryRun: true;
  week: string;
  stats: {
    queries: number;
    requests: number;
    rawItems: number;
    uniqueRepos: number;
    afterDedupe: number;
    afterRules: number;
    selected: number;
    deferred: number;
  };
  errorsBySource: SourceError[];
  /** Descartados por regla, solo las que descartaron algo. */
  descartadosPorRegla: Partial<Record<FilterRule, number>>;
  /** Por categoría sugerida: elegibles tras las reglas, los que entrarían al batch y los diferidos. */
  categorias: {
    categoria: string;
    elegibles: number;
    seleccionados: number;
    diferidos: number;
  }[];
  /** Peticiones `core` que gastaría el enrich de los seleccionados (80 × 3 = 240 el 2026-09-30). */
  enrichRequestsEstimadas: number;
  /** `false` si no existía `data/seen.sqlite`: el dedupe no tuvo nada que comparar. */
  seenLeida: boolean;
  /** Ejemplos de lo que entraría al batch, por si se quiere mirar a ojo. */
  muestra: { name: string; categoria: string; stars: number }[];
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
  options: CollectOptions & { dryRun: true },
): Promise<DryRunSummary>;
export async function collectWeek(
  options: CollectOptions,
): Promise<CollectSummary>;
export async function collectWeek(
  options: CollectOptions,
): Promise<CollectSummary | DryRunSummary> {
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
  const dbPath = path.join(repoDir, 'data', 'seen.sqlite');
  // En el ensayo la base se abre en solo lectura y, si no existe, no se crea.
  const db: Db | null = options.dryRun
    ? (options.db ?? getReadonlyDb(dbPath))
    : (options.db ?? getDb(dbPath));
  // Y sin caché en disco: `data/` queda literalmente intacto.
  const cacheDir = options.dryRun
    ? undefined
    : path.join(repoDir, 'data', 'cache', 'github');
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
  let fresh = normalized;
  let seenLeida = db !== null;
  if (db) {
    try {
      fresh = await dedupeCandidates(normalized, db);
    } catch (err) {
      // Una base de solo lectura de otra versión puede no tener la tabla `seen`.
      if (!options.dryRun || !/no such table/i.test((err as Error).message)) {
        throw err;
      }
      seenLeida = false;
    }
  }
  const { kept, descartados } = filterCandidates(
    fresh,
    interests,
    catalog,
    now,
  );
  const { selected, deferred } = selectForEnrichment(kept, interests, now);

  if (options.dryRun) {
    const byRule: DryRunSummary['descartadosPorRegla'] = {};
    for (const d of descartados) byRule[d.regla] = (byRule[d.regla] ?? 0) + 1;
    const categories = new Map<
      string,
      { elegibles: number; seleccionados: number; diferidos: number }
    >();
    const row = (categoria: string) => {
      const found = categories.get(categoria);
      if (found) return found;
      const created = { elegibles: 0, seleccionados: 0, diferidos: 0 };
      categories.set(categoria, created);
      return created;
    };
    for (const c of kept) row(c.categoriaSugerida).elegibles++;
    for (const c of selected) row(c.categoriaSugerida).seleccionados++;
    for (const d of deferred) row(d.categoria).diferidos++;
    return {
      dryRun: true,
      week,
      stats: {
        queries: search.stats.queries,
        requests: search.stats.requests,
        rawItems: search.stats.rawItems,
        uniqueRepos: search.stats.uniqueRepos,
        afterDedupe: fresh.length,
        afterRules: kept.length,
        selected: selected.length,
        deferred: deferred.length,
      },
      errorsBySource: search.errors,
      descartadosPorRegla: byRule,
      categorias: [...categories.entries()]
        .map(([categoria, n]) => ({ categoria, ...n }))
        .sort((a, b) => b.elegibles - a.elegibles),
      enrichRequestsEstimadas: selected.length * 3,
      seenLeida,
      muestra: selected.slice(0, 10).map((c) => ({
        name: c.name,
        categoria: c.categoriaSugerida,
        stars: c.stars,
      })),
    };
  }
  if (!db)
    throw new Error('Sin base de datos: no se puede registrar la recogida.');

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

/** Líneas para la terminal con el resultado de `spf collect --dry-run`. */
export function formatDryRun(r: DryRunSummary): string[] {
  const s = r.stats;
  const rules =
    Object.entries(r.descartadosPorRegla)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, n]) => `${rule} ${n}`)
      .join(' · ') || 'ninguno';
  const lines = [
    `DRY-RUN · semana ${r.week} · github-search — no se escribe nada (ni data/candidates, ni seen.sqlite, ni runs, ni caché) y no se enriquece`,
    `  ${s.queries} consultas → ${s.requests} peticiones de búsqueda → ${s.rawItems} resultados → ${s.uniqueRepos} repos únicos`,
    `  dedupe (${r.seenLeida ? 'seen.sqlite en solo lectura' : 'sin seen.sqlite: nada visto'}): ${s.afterDedupe} · tras reglas: ${s.afterRules} (${s.afterDedupe - s.afterRules} descartados: ${rules})`,
    `  entrarían al batch: ${s.selected} · diferidos por el tope: ${s.deferred} · el enrich gastaría ~${r.enrichRequestsEstimadas} peticiones core`,
    '  por categoría (elegibles → al batch, +diferidos):',
    ...r.categorias.map(
      (c) =>
        `    ${c.categoria.padEnd(24)} ${String(c.elegibles).padStart(4)} → ${String(c.seleccionados).padStart(3)} (+${c.diferidos})`,
    ),
    `  errores por fuente: ${r.errorsBySource.length}`,
  ];
  for (const e of r.errorsBySource) {
    lines.push(`    error: ${e.query ?? e.source}: ${e.message}`);
  }
  if (r.muestra.length > 0) {
    lines.push(
      '  primeros del batch:',
      ...r.muestra.map((m) => `    ${m.name} (${m.categoria}, ${m.stars}★)`),
    );
  }
  return lines;
}
