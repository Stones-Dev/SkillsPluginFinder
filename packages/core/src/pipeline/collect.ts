import crypto from 'node:crypto';
import path from 'node:path';
import pLimit from 'p-limit';
import {
  ANTHROPIC_SOURCE_ID,
  type AnthropicResult,
  type AnthropicSourceReport,
  type OfficialEntry,
  collectFromAnthropic,
  finalizeAnthropicSnapshots,
  writeAnthropicSnapshots,
} from '../collectors/anthropic.js';
import {
  AWESOME_SOURCE_ID,
  type AwesomeListReport,
  type AwesomeResult,
  collectFromAwesomeLists,
  finalizeSnapshots,
  writeAwesomeSnapshots,
} from '../collectors/awesome.js';
import {
  createGithubClient,
  requireToken,
} from '../collectors/github-client.js';
import {
  type GithubRepo,
  SOURCE_ID,
  type SourceError,
  collectFromGithub,
} from '../collectors/github.js';
import {
  MCP_SOURCE_ID,
  type McpRegistryReport,
  type McpRegistryResult,
  collectFromMcpRegistry,
  finalizeMcpRegistryState,
  writeMcpRegistryState,
} from '../collectors/mcp-registry.js';
import { loadCatalog, loadInterests } from '../config/interests.js';
import { type Db, getDb, getReadonlyDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { applyEnrichment, enrichGithubRepo } from '../enrich/github.js';
import { type FilterRule, filterCandidates } from '../filter/index.js';
import {
  type Candidate,
  type Origin,
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
/** Fuentes que entiende `--source`; sin él se recogen todas. */
export const COLLECT_SOURCES = [
  SOURCE_ID,
  AWESOME_SOURCE_ID,
  ANTHROPIC_SOURCE_ID,
  MCP_SOURCE_ID,
] as const;

export type CollectOptions = {
  repoDir: string;
  token: string | undefined;
  /** Una sola fuente (`--source`). Tiene prioridad sobre `sources`. */
  source?: string;
  /** Restringe las fuentes (programático, p. ej. en tests); sin `source` ni `sources`, todas. */
  sources?: readonly string[];
  now?: Date;
  /** `schedule` | `workflow_dispatch` (Actions) o `manual`. */
  trigger?: string;
  logger?: (message: string) => void;
  db?: Db;
  /**
   * Ensayo: colectores, normalize, dedupe (solo lectura), reglas y tope, con resumen,
   * **sin escribir nada**: ni `data/candidates/`, ni `seen.sqlite`, ni `runs`, ni la
   * caché HTTP de `data/cache/`. Tampoco enriquece (gastaría ~3 peticiones `core`
   * por repo). Sí gasta las peticiones de búsqueda. Única excepción: crea las
   * instantáneas de `data/awesome/`, `data/anthropic/` y `data/mcp-registry/` que falten (nunca
   * sobrescribe una existente).
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
  /** Fuentes que se ejecutaron. */
  fuentes: string[];
  /** Colector `awesome-list`; ausente si no se ejecutó. */
  awesome?: {
    listas: AwesomeListReport[];
    /** Peticiones `core` gastadas (READMEs y `GET /repos`). */
    requests: number;
    /** READMEs que contestaron 304 gracias a la ETag. */
    notModified: number;
    /** Instantáneas de `data/awesome/` que no existían y se han creado. */
    snapshotsCreadas: number;
  };
  /** Colector `mcp-registry`; ausente si no se ejecutó. */
  mcpRegistry?: {
    report: McpRegistryReport;
    /** Peticiones al registro MCP (páginas). */
    requests: number;
    /** Consultas GraphQL a GitHub y puntos del cubo GraphQL que han costado. */
    lotes: number;
    puntos: number;
    /** Si el estado de `data/mcp-registry/` no existía y se ha creado. */
    estadoCreado: boolean;
  };
  /** Colector `anthropic-skills`; ausente si no se ejecutó. */
  anthropic?: {
    repos: AnthropicSourceReport[];
    /** Changelog oficial desde la última ejecución (lo que iría al informe). */
    oficiales: OfficialEntry[];
    /** Peticiones `core` gastadas (commits, ficheros y `GET /repos`). */
    requests: number;
    /** Listados de commits que contestaron 304 gracias a la ETag. */
    notModified: number;
    /** Instantáneas de `data/anthropic/` que no existían y se han creado. */
    snapshotsCreadas: number;
  };
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
  const requested: readonly string[] = options.source
    ? [options.source]
    : (options.sources ?? COLLECT_SOURCES);
  for (const source of requested) {
    if (!(COLLECT_SOURCES as readonly string[]).includes(source)) {
      throw new Error(
        `Fuente no soportada: ${source} (solo ${COLLECT_SOURCES.join(', ')})`,
      );
    }
  }
  const wants = (source: string) => requested.includes(source);
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

  const hasAwesome = Object.keys(interests.awesome_listas).length > 0;
  if (requested.length === 1 && wants(AWESOME_SOURCE_ID) && !hasAwesome) {
    throw new Error(
      'Sin listas que recoger: añade el bloque awesome_listas a Intereses.md y ejecuta "pnpm spf interests sync".',
    );
  }
  if (
    requested.length === 1 &&
    wants(MCP_SOURCE_ID) &&
    !interests.mcp_registry_categoria
  ) {
    throw new Error(
      'Sin categoría para el registro MCP: añade mcp_registry_categoria a Intereses.md y ejecuta "pnpm spf interests sync".',
    );
  }
  const fuentes: string[] = [];

  const search = wants(SOURCE_ID)
    ? await collectFromGithub({ token, interests, now, ...client })
    : {
        repos: [],
        errors: [],
        stats: {
          queries: 0,
          executed: 0,
          requests: 0,
          cacheHits: 0,
          rawItems: 0,
          uniqueRepos: 0,
        },
      };
  if (wants(SOURCE_ID)) fuentes.push(SOURCE_ID);
  const failedQueries = search.errors.filter((e) => e.query).length;
  if (search.stats.executed > 0 && failedQueries === search.stats.executed) {
    throw new Error(
      `Todas las consultas de ${SOURCE_ID} fallaron (${search.errors[0].message}); no se escribe nada.`,
    );
  }

  let awesome: AwesomeResult | undefined;
  if (wants(AWESOME_SOURCE_ID) && hasAwesome) {
    awesome = await collectFromAwesomeLists({
      token,
      interests,
      now,
      snapshotDir: path.join(repoDir, 'data', 'awesome'),
      logger,
      throttle: options.throttle,
      retryBaseMs: options.retryBaseMs,
    });
    fuentes.push(AWESOME_SOURCE_ID);
    if (!wants(SOURCE_ID) && awesome.lists.every((l) => l.estado === 'error')) {
      throw new Error(
        `Todas las listas de ${AWESOME_SOURCE_ID} fallaron (${awesome.errors[0].message}); no se escribe nada.`,
      );
    }
  }

  let anthropic: AnthropicResult | undefined;
  if (wants(ANTHROPIC_SOURCE_ID)) {
    anthropic = await collectFromAnthropic({
      token,
      now,
      snapshotDir: path.join(repoDir, 'data', 'anthropic'),
      categoria: interests.anthropic_categoria,
      logger,
      throttle: options.throttle,
      retryBaseMs: options.retryBaseMs,
    });
    fuentes.push(ANTHROPIC_SOURCE_ID);
    if (
      !wants(SOURCE_ID) &&
      anthropic.sources.every((s) => s.estado === 'error')
    ) {
      throw new Error(
        `Todos los repos de ${ANTHROPIC_SOURCE_ID} fallaron (${anthropic.errors[0].message}); no se escribe nada.`,
      );
    }
  }

  let mcp: McpRegistryResult | undefined;
  if (wants(MCP_SOURCE_ID) && interests.mcp_registry_categoria) {
    // Todo candidato del registro lleva el origen de `mcp_registry_categoria` (3 puntos en la
    // categoría sugerida), así que sus estrellas se juzgan con el mínimo de esa categoría: pedir
    // el detalle de menos estrellas sería trabajo que las reglas descartan después (en vivo,
    // con el suelo más bajo de todas las categorías, 87 de 163 repos).
    const minStars =
      interests.categorias[interests.mcp_registry_categoria]?.estrellas_min ??
      interests.reglas_globales.estrellas_min;
    mcp = await collectFromMcpRegistry({
      token,
      now,
      stateDir: path.join(repoDir, 'data', 'mcp-registry'),
      categoria: interests.mcp_registry_categoria,
      minStars,
      logger,
      throttle: options.throttle,
      retryBaseMs: options.retryBaseMs,
    });
    fuentes.push(MCP_SOURCE_ID);
    if (requested.length === 1 && mcp.report.estado === 'error') {
      throw new Error(
        `El registro MCP falló (${mcp.errors[0]?.message ?? 'sin detalle'}); no se escribe nada.`,
      );
    }
  }

  // Un repo que sale de varias fuentes es un solo candidato con todos sus orígenes.
  const found = new Map<
    string,
    {
      repo: GithubRepo;
      origins: Origin[];
      source: Candidate['source'];
      notes?: string[];
    }
  >();
  for (const r of search.repos) {
    found.set(r.repo.full_name.toLowerCase(), { ...r, source: SOURCE_ID });
  }
  for (const r of awesome?.repos ?? []) {
    const key = r.repo.full_name.toLowerCase();
    const existing = found.get(key);
    if (existing) existing.origins.push(...r.origins);
    else found.set(key, { ...r, source: AWESOME_SOURCE_ID });
  }
  for (const r of anthropic?.repos ?? []) {
    const key = r.repo.full_name.toLowerCase();
    const existing = found.get(key);
    if (existing) existing.origins.push(...r.origins);
    else found.set(key, { ...r, source: ANTHROPIC_SOURCE_ID });
  }
  for (const r of mcp?.repos ?? []) {
    const key = r.repo.full_name.toLowerCase();
    const existing = found.get(key);
    if (existing) {
      existing.origins.push(...r.origins);
      existing.notes = [...(existing.notes ?? []), ...r.notes];
    } else found.set(key, { ...r, source: MCP_SOURCE_ID });
  }
  const normalized = [...found.values()].map((r) =>
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

  const deferredNames = deferred.map((d) => d.name.toLowerCase());

  if (options.dryRun) {
    // Única escritura del ensayo: la instantánea que falta, para que la próxima
    // pasada ya tenga con qué comparar. Una que existe no se toca.
    const snapshotsCreadas = awesome
      ? (
          await writeAwesomeSnapshots(
            finalizeSnapshots(awesome, deferredNames),
            { onlyMissing: true },
          )
        ).length
      : 0;
    const estadoMcp = mcp
      ? (
          await writeMcpRegistryState(
            finalizeMcpRegistryState(mcp, deferredNames),
            { onlyMissing: true },
          )
        ).length > 0
      : false;
    const anthropicCreadas = anthropic
      ? (
          await writeAnthropicSnapshots(
            finalizeAnthropicSnapshots(anthropic, deferredNames),
            { onlyMissing: true },
          )
        ).length
      : 0;
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
        rawItems:
          search.stats.rawItems +
          (awesome?.stats.resueltos ?? 0) +
          (anthropic?.stats.resueltos ?? 0) +
          (mcp?.report.detallados ?? 0),
        uniqueRepos: found.size,
        afterDedupe: fresh.length,
        afterRules: kept.length,
        selected: selected.length,
        deferred: deferred.length,
      },
      fuentes,
      awesome: awesome && {
        listas: awesome.lists,
        requests: awesome.stats.requests,
        notModified: awesome.stats.notModified,
        snapshotsCreadas,
      },
      mcpRegistry: mcp && {
        report: mcp.report,
        requests: mcp.stats.requests,
        lotes: mcp.stats.lotes,
        puntos: mcp.stats.puntos,
        estadoCreado: estadoMcp,
      },
      anthropic: anthropic && {
        repos: anthropic.sources,
        oficiales: anthropic.oficiales,
        requests: anthropic.stats.requests,
        notModified: anthropic.stats.notModified,
        snapshotsCreadas: anthropicCreadas,
      },
      errorsBySource: [
        ...search.errors,
        ...(awesome?.errors ?? []),
        ...(anthropic?.errors ?? []),
        ...(mcp?.errors ?? []),
      ],
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
    rawItems:
      search.stats.rawItems +
      (awesome?.stats.resueltos ?? 0) +
      (anthropic?.stats.resueltos ?? 0) +
      (mcp?.report.detallados ?? 0),
    uniqueRepos: found.size,
    afterDedupe: fresh.length,
    afterRules: kept.length,
    selected: selected.length,
    deferred: deferred.length,
    enriched: enriched.length,
    ...(awesome && {
      awesomeLists: awesome.stats.lists,
      awesomeRequests: awesome.stats.requests,
      awesomeNotModified: awesome.stats.notModified,
      awesomeNuevos: awesome.stats.nuevos,
      awesomeResueltos: awesome.stats.resueltos,
      awesomePendientes: awesome.stats.pendientes,
    }),
    ...(mcp && {
      mcpPaginas: mcp.report.paginas,
      mcpFilas: mcp.report.filas,
      mcpRepos: mcp.report.repos,
      mcpConsultados: mcp.report.consultados,
      mcpDetallados: mcp.report.detallados,
      mcpLotes: mcp.stats.lotes,
      mcpPendientes: mcp.report.pendientes,
    }),
    ...(anthropic && {
      anthropicRequests: anthropic.stats.requests,
      anthropicNotModified: anthropic.stats.notModified,
      anthropicCambios: anthropic.stats.cambios,
      anthropicResueltos: anthropic.stats.resueltos,
      anthropicPendientes: anthropic.stats.pendientes,
    }),
  };
  const run: RunRecord = {
    at: now.toISOString(),
    trigger: options.trigger ?? 'manual',
    stats,
    errorsBySource: [
      ...search.errors,
      ...(awesome?.errors ?? []),
      ...(anthropic?.errors ?? []),
      ...(mcp?.errors ?? []),
    ],
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
    oficiales: anthropic?.oficiales,
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

  // Lo último: si algo falló antes, las instantáneas siguen siendo las de la semana
  // anterior y las novedades se vuelven a ver en la siguiente ejecución.
  if (awesome) {
    await writeAwesomeSnapshots(finalizeSnapshots(awesome, deferredNames));
  }
  if (anthropic) {
    await writeAnthropicSnapshots(
      finalizeAnthropicSnapshots(anthropic, deferredNames),
    );
  }
  if (mcp) {
    await writeMcpRegistryState(finalizeMcpRegistryState(mcp, deferredNames));
  }

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
    `DRY-RUN · semana ${r.week} · ${r.fuentes.join(' + ')} — no se escribe nada (ni data/candidates, ni seen.sqlite, ni runs, ni caché${r.awesome || r.anthropic || r.mcpRegistry ? `, salvo las instantáneas de ${[r.awesome && 'data/awesome', r.anthropic && 'data/anthropic', r.mcpRegistry && 'data/mcp-registry'].filter(Boolean).join(' y ')} que falten` : ''}) y no se enriquece`,
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
  if (r.awesome) lines.push(...formatAwesome(r.awesome));
  if (r.anthropic) lines.push(...formatAnthropic(r.anthropic));
  if (r.mcpRegistry) lines.push(...formatMcpRegistry(r.mcpRegistry));
  if (r.muestra.length > 0) {
    lines.push(
      '  primeros del batch:',
      ...r.muestra.map((m) => `    ${m.name} (${m.categoria}, ${m.stars}★)`),
    );
  }
  return lines;
}

function formatAwesome(a: NonNullable<DryRunSummary['awesome']>): string[] {
  const state: Record<AwesomeListReport['estado'], string> = {
    'primera-pasada': 'primera pasada (instantánea, sin candidatos)',
    'sin-cambios': 'sin cambios',
    'con-cambios': 'con cambios',
    error: 'ERROR',
  };
  return [
    `  awesome-list: ${a.listas.length} listas · ${a.requests} peticiones core (${a.notModified} READMEs con 304) · instantáneas creadas: ${a.snapshotsCreadas}`,
    ...a.listas.map(
      (l) =>
        `    ${l.repo.padEnd(38)} ${state[l.estado]}${l.enlaces === null ? '' : ` · ${l.enlaces} enlaces`}${l.estado === 'con-cambios' ? ` · +${l.nuevos} -${l.quitados} (resueltos ${l.resueltos}, desaparecidos ${l.desaparecidos}, pendientes ${l.pendientes})` : ''} → ${l.categoria}`,
    ),
  ];
}

function formatAnthropic(a: NonNullable<DryRunSummary['anthropic']>): string[] {
  const state: Record<AnthropicSourceReport['estado'], string> = {
    'primera-pasada': 'primera pasada (instantánea, sin changelog)',
    'sin-cambios': 'sin cambios',
    'con-cambios': 'con cambios',
    error: 'ERROR',
  };
  const lines = [
    `  anthropic-skills: ${a.repos.length} repos · ${a.requests} peticiones core (${a.notModified} listados de commits con 304) · instantáneas creadas: ${a.snapshotsCreadas}`,
    ...a.repos.map(
      (s) =>
        `    ${s.repo.padEnd(38)} ${state[s.estado]}${s.items === null ? '' : ` · ${s.items} elementos`}${s.estado === 'con-cambios' ? ` · +${s.nuevos} ~${s.actualizados} -${s.eliminados} (candidatos resueltos ${s.resueltos}, desaparecidos ${s.desaparecidos}, pendientes ${s.pendientes})` : ''}`,
    ),
  ];
  for (const entry of a.oficiales) {
    lines.push(
      `    changelog ${entry.fuente} (${entry.desde}…${entry.hasta}): ${entry.cambios.length} cambios, ${entry.commits.length}${entry.masCommits ? '+' : ''} commits`,
    );
    for (const c of entry.cambios.slice(0, 12)) {
      lines.push(`      ${c.cambio.padEnd(11)} ${c.tipo} ${c.nombre}`);
    }
    if (entry.cambios.length > 12) {
      lines.push(`      … y ${entry.cambios.length - 12} más`);
    }
  }
  return lines;
}

function formatMcpRegistry(
  m: NonNullable<DryRunSummary['mcpRegistry']>,
): string[] {
  const r = m.report;
  const head = `  mcp-registry: ${m.requests} páginas del registro · ${m.lotes} consultas GraphQL (${m.puntos} puntos del cubo GraphQL)${m.estadoCreado ? ' · estado creado' : ''}`;
  if (r.estado === 'primera-pasada') {
    return [head, '    primera pasada (se anota la hora; sin candidatos)'];
  }
  if (r.estado === 'error') return [head, '    ERROR (ver errores por fuente)'];
  return [
    head,
    `    registro: ${r.filas} servidores actualizados → ${r.activos} activos → ${r.conGithub} con repo de GitHub → ${r.repos} repos distintos`,
    `    etapa 1 (estrellas): ${r.consultados} consultados${r.omitidos > 0 ? ` · ${r.omitidos} omitidos por el tope` : ''} → ${r.conEstrellas} llegan al mínimo → etapa 2 (detalle): ${r.detallados} candidatos · desaparecidos ${r.desaparecidos} · pendientes ${r.pendientes}`,
    ...(r.ventanaAcotada
      ? [
          '    la última lectura era de hace más de 14 días: se miró solo ese tramo',
        ]
      : []),
    ...(r.truncado ? ['    listado cortado por el tope de páginas'] : []),
  ];
}
