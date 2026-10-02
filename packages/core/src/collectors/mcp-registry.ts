import path from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { Origin } from '../normalize/candidate.js';
import {
  USER_AGENT,
  createGithubClient,
  requireToken,
} from './github-client.js';
import {
  GRAPHQL_BATCH,
  REPO_FIELDS,
  STARS_FIELDS,
  queryRepoBatch,
  toGithubRepo,
} from './github-graphql.js';
import {
  COLLECTOR_TIMEOUT_MS,
  type GithubRepo,
  type SourceError,
} from './github.js';
import {
  type SnapshotWrite,
  readSnapshotFile,
  snapshotFileName,
  writeSnapshots,
} from './snapshots.js';

export const MCP_SOURCE_ID = 'mcp-registry';
/** Registro oficial MCP (verificado el 2026-10-02: público, sin auth; `/v0` responde igual). */
export const REGISTRY_ID = 'registry.modelcontextprotocol.io';
export const REGISTRY_SERVERS_URL = `https://${REGISTRY_ID}/v0.1/servers`;
const PAGE_SIZE = 100;
/** Páginas de 100 que se leen por recogida (una semana son ~63; dos, ~99). */
export const MAX_PAGES = 120;
/** Ventana máxima hacia atrás: si hace más desde la última vez, se mira solo este tramo. */
export const MAX_WINDOW_DAYS = 14;
/** Repos distintos a los que se mira las estrellas (etapa 1) por recogida. */
export const MAX_STARS_LOOKUPS = 1500;
/** Repos que pasan el mínimo de estrellas y reciben el detalle completo (etapa 2). */
export const MAX_DETAILS = 300;
/** Repos pendientes que se guardan para la semana siguiente. */
export const MAX_PENDING = 300;
const GRAPHQL_CONCURRENCY = 2;
const REGISTRY_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const META_KEY = 'io.modelcontextprotocol.registry/official';

/** Lo que se recuerda entre semanas: hasta dónde se ha leído el registro y qué quedó pendiente. */
export const mcpRegistryStateSchema = z
  .object({
    version: z.literal(1),
    repo: z.string().min(1),
    /** Corte de la próxima lectura (`updated_since`). */
    syncedAt: z.string(),
    /** Repos que vuelven la semana siguiente (tope, error transitorio o diferidos por `enrich_max`). */
    pending: z.array(
      z.object({ repo: z.string().min(1), nota: z.string() }).strict(),
    ),
  })
  .strict();

export type McpRegistryState = z.infer<typeof mcpRegistryStateSchema>;

export const mcpRegistryStatePath = (stateDir: string) =>
  path.join(stateDir, snapshotFileName(REGISTRY_ID));

const entrySchema = z
  .object({
    server: z
      .object({
        name: z.string().min(1),
        version: z.string().optional(),
        repository: z
          .object({
            url: z.string().optional(),
            source: z.string().optional(),
          })
          .passthrough()
          .optional(),
        packages: z
          .array(
            z
              .object({
                registryType: z.string().optional(),
                identifier: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
        remotes: z
          .array(z.object({ type: z.string().optional() }).passthrough())
          .optional(),
      })
      .passthrough(),
    _meta: z.record(z.unknown()).optional(),
  })
  .passthrough();

const pageSchema = z
  .object({
    servers: z.array(entrySchema),
    metadata: z
      .object({ nextCursor: z.string().nullish() })
      .passthrough()
      .optional(),
  })
  .passthrough();

type RegistryEntry = z.infer<typeof entrySchema>;

const GITHUB_URL =
  /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i;

/** `Owner/Repo` (con la capitalización de la URL) si el servidor vive en GitHub. */
export function githubRepoOf(entry: RegistryEntry): string | null {
  const repository = entry.server.repository;
  if (repository?.source !== 'github' || !repository.url) return null;
  const match = GITHUB_URL.exec(repository.url);
  return match ? `${match[1]}/${match[2]}` : null;
}

const metaOf = (entry: RegistryEntry) =>
  (entry._meta?.[META_KEY] ?? {}) as {
    status?: string;
    publishedAt?: string;
  };

/** Resumen del manifiesto para el evaluador: paquetes publicados y transportes remotos. */
export function registryNote(
  servers: {
    name: string;
    version: string;
    packages: string[];
    remotes: string[];
  }[],
): string {
  const [first, ...rest] = servers;
  const parts = [`Registro MCP: ${first.name} ${first.version}`.trim()];
  if (rest.length > 0)
    parts[0] += ` (+${rest.length} servidores más del mismo repo)`;
  const packages = [...new Set(servers.flatMap((s) => s.packages))];
  const remotes = [...new Set(servers.flatMap((s) => s.remotes))];
  if (packages.length > 0)
    parts.push(`paquetes: ${packages.slice(0, 3).join(', ')}`);
  if (remotes.length > 0) parts.push(`remotos: ${remotes.join(', ')}`);
  const note = parts.join(' · ');
  return note.length > 280 ? `${note.slice(0, 279)}…` : note;
}

export type McpRegistryReport = {
  estado: 'primera-pasada' | 'con-cambios' | 'sin-cambios' | 'error';
  /** Páginas del registro leídas. */
  paginas: number;
  /** Servidores (última versión) actualizados desde la última lectura. */
  filas: number;
  /** De ellos, activos (no `deleted` ni `deprecated`). */
  activos: number;
  /** Activos con repo de GitHub (el resto es solo remoto, GitLab o sin repo: no son candidatos). */
  conGithub: number;
  /** Repos de GitHub distintos entre ellos. */
  repos: number;
  /** Repos a los que se miró las estrellas (etapa 1). */
  consultados: number;
  /** Los que llegan al mínimo de estrellas. */
  conEstrellas: number;
  /** Los que recibieron el detalle completo (etapa 2) y salen como candidatos. */
  detallados: number;
  /** Repos que ya no existen. */
  desaparecidos: number;
  /** Repos que quedaron fuera del tope de consultas de estrellas. */
  omitidos: number;
  /** Repos que vuelven la semana siguiente. */
  pendientes: number;
  /** El listado se cortó en `MAX_PAGES`: faltó el final (alfabético) del registro. */
  truncado: boolean;
  /** La última lectura era de hace más de `MAX_WINDOW_DAYS`: se miró solo ese tramo. */
  ventanaAcotada: boolean;
};

type Draft = {
  file: string;
  existed: boolean;
  snapshot: McpRegistryState;
  /** Nota del manifiesto por repo (en minúsculas), para los que se difieran después. */
  notas: Map<string, { repo: string; nota: string }>;
  /** Repo (minúsculas) → `full_name` en minúsculas con el que resolvió (puede haberse renombrado). */
  resolved: Map<string, string>;
};

export type McpRegistryResult = {
  repos: { repo: GithubRepo; origins: Origin[]; notes: string[] }[];
  errors: SourceError[];
  report: McpRegistryReport;
  stats: {
    /** Peticiones al registro (páginas). */
    requests: number;
    /** Consultas GraphQL a GitHub. */
    lotes: number;
    /** Puntos del cubo GraphQL gastados. */
    puntos: number;
  };
  drafts: Draft[];
};

export type CollectMcpRegistryOptions = {
  token: string | undefined;
  now?: Date;
  /** `data/mcp-registry`. */
  stateDir: string;
  /** Categoría (de `Intereses.md`) de los candidatos que salen del registro. */
  categoria: string;
  /** Mínimo de estrellas para pasar a la etapa 2: el de `categoria` (o el de las reglas globales). */
  minStars: number;
  logger?: (message: string) => void;
  deadlineMs?: number;
  maxStarsLookups?: number;
  maxDetails?: number;
  maxPages?: number;
  /** Solo tests. */
  throttle?: boolean;
  retryBaseMs?: number;
  fetch?: typeof fetch;
};

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RetryableError extends Error {}

/** Una página del registro, con reintentos ante 5xx, 429 y fallos de red. */
async function fetchPage(
  url: string,
  options: { fetch: typeof fetch; retryBaseMs: number },
): Promise<z.infer<typeof pageSchema>> {
  for (let attempt = 0; ; attempt++) {
    try {
      let res: Response;
      try {
        res = await options.fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new RetryableError(messageOf(err));
      }
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
      const parsed = pageSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(
          'el registro devolvió una página con una forma inesperada',
        );
      }
      return parsed.data;
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= REGISTRY_RETRIES) {
        throw err;
      }
      await sleep(options.retryBaseMs * 2 ** attempt);
    }
  }
}

type RepoInfo = {
  repo: string;
  servers: {
    name: string;
    version: string;
    packages: string[];
    remotes: string[];
    publishedAt: string;
  }[];
  hasPackages: boolean;
  newest: string;
};

/**
 * Colector `mcp-registry` (Fuentes.md): servidores MCP del registro oficial
 * (`registry.modelcontextprotocol.io`, API REST pública y sin autenticación).
 *
 * El registro es un caudal, no un catálogo: tiene más de 20.000 servidores y cada
 * semana se actualizan ~6.000 (≈4.100 repos de GitHub distintos; solo el 5,9 % llega
 * a 30★). Resolver cada repo con REST costaría ~4.100 peticiones `core` por semana,
 * así que:
 *
 * 1. Se lee `GET /v0.1/servers?version=latest&updated_since=<última lectura>` (el
 *    listado pagina de 100 en 100) y se quedan los activos con repo de GitHub.
 * 2. **Etapa 1**: las estrellas de cada repo con consultas GraphQL de 25 en 25 (1 punto
 *    y ~1,2 s cada una). Con tope, y por orden: los pendientes de la vez anterior, los
 *    que publican paquetes (npm, PyPI, OCI… ⇒ 14,7 % llega a 30★) y, al final, los
 *    solo remotos (1,1 %), más recientes primero.
 * 3. **Etapa 2**: el detalle completo solo de los que llegan al mínimo de estrellas.
 *    Salen como candidatos (origen `registry`, con el manifiesto resumido en las notas
 *    de riesgo) y siguen por el normalize, dedupe, reglas y tope de siempre.
 *
 * Primera pasada (sin estado): solo se anota la hora. Lo que supera los topes, falla de
 * forma transitoria o difiere `enrich_max` se guarda como pendiente (hasta
 * `MAX_PENDING`). El estado se escribe al final de la recogida, como en `awesome-list`.
 * Un fallo del registro no avanza el estado.
 */
export async function collectFromMcpRegistry(
  options: CollectMcpRegistryOptions,
): Promise<McpRegistryResult> {
  const token = requireToken(options.token);
  const now = options.now ?? new Date();
  const doFetch = options.fetch ?? fetch;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const { octokit } = createGithubClient({
    token,
    logger: options.logger,
    throttle: options.throttle,
    retryBaseMs: options.retryBaseMs,
  });
  const deadline = Date.now() + (options.deadlineMs ?? COLLECTOR_TIMEOUT_MS);
  const maxLookups = options.maxStarsLookups ?? MAX_STARS_LOOKUPS;
  const maxDetails = options.maxDetails ?? MAX_DETAILS;
  const maxPages = options.maxPages ?? MAX_PAGES;

  const report: McpRegistryReport = {
    estado: 'error',
    paginas: 0,
    filas: 0,
    activos: 0,
    conGithub: 0,
    repos: 0,
    consultados: 0,
    conEstrellas: 0,
    detallados: 0,
    desaparecidos: 0,
    omitidos: 0,
    pendientes: 0,
    truncado: false,
    ventanaAcotada: false,
  };
  const errors: SourceError[] = [];
  const stats = { requests: 0, lotes: 0, puntos: 0 };
  const result = (
    repos: McpRegistryResult['repos'] = [],
    drafts: Draft[] = [],
  ) => ({ repos, errors, report, stats, drafts }) satisfies McpRegistryResult;

  const file = mcpRegistryStatePath(options.stateDir);
  let previous: McpRegistryState | null;
  try {
    previous = await readSnapshotFile(
      file,
      REGISTRY_ID,
      mcpRegistryStateSchema,
    );
  } catch (err) {
    errors.push({
      source: MCP_SOURCE_ID,
      query: REGISTRY_ID,
      message: messageOf(err),
    });
    return result();
  }

  const draftOf = (pending: { repo: string; nota: string }[]): Draft => ({
    file,
    existed: previous !== null,
    snapshot: {
      version: 1,
      repo: REGISTRY_ID,
      syncedAt: now.toISOString(),
      pending: pending.slice(0, MAX_PENDING),
    },
    notas: new Map(pending.map((p) => [p.repo.toLowerCase(), p])),
    resolved: new Map(),
  });

  // — Lectura del registro —
  const base = (qs: Record<string, string>) =>
    `${REGISTRY_SERVERS_URL}?${new URLSearchParams(qs).toString()}`;

  if (!previous) {
    // Primera pasada: una petición para comprobar que el registro responde, y solo se anota la hora.
    try {
      await fetchPage(base({ version: 'latest', limit: '1' }), {
        fetch: doFetch,
        retryBaseMs,
      });
      stats.requests++;
      report.estado = 'primera-pasada';
      return result([], [draftOf([])]);
    } catch (err) {
      errors.push({
        source: MCP_SOURCE_ID,
        query: REGISTRY_ID,
        message: messageOf(err),
      });
      return result();
    }
  }

  const windowStart = now.getTime() - MAX_WINDOW_DAYS * DAY_MS;
  const syncedAt = Date.parse(previous.syncedAt);
  report.ventanaAcotada = syncedAt < windowStart;
  const since = new Date(Math.max(syncedAt, windowStart)).toISOString();

  const rows: RegistryEntry[] = [];
  try {
    let cursor: string | null = null;
    do {
      const qs: Record<string, string> = {
        version: 'latest',
        updated_since: since,
        limit: String(PAGE_SIZE),
      };
      if (cursor) qs.cursor = cursor;
      const page = await fetchPage(base(qs), { fetch: doFetch, retryBaseMs });
      stats.requests++;
      report.paginas++;
      rows.push(...page.servers);
      cursor = page.metadata?.nextCursor ?? null;
      if (cursor && report.paginas >= maxPages) {
        report.truncado = true;
        cursor = null;
      }
    } while (cursor);
  } catch (err) {
    // El registro falló a mitad: no se avanza el estado y la semana siguiente se vuelve a leer todo.
    errors.push({
      source: MCP_SOURCE_ID,
      query: REGISTRY_ID,
      message: messageOf(err),
    });
    return result();
  }
  if (report.truncado) {
    errors.push({
      source: MCP_SOURCE_ID,
      query: REGISTRY_ID,
      message: `Listado cortado en ${maxPages} páginas: falta el final (por orden alfabético) del registro`,
    });
  }
  report.filas = rows.length;

  // — Servidores activos con repo de GitHub, agrupados por repo —
  const byRepo = new Map<string, RepoInfo>();
  for (const entry of rows) {
    const meta = metaOf(entry);
    if (meta.status && meta.status !== 'active') continue;
    report.activos++;
    const repo = githubRepoOf(entry);
    if (!repo) continue;
    report.conGithub++;
    const key = repo.toLowerCase();
    const server = {
      name: entry.server.name,
      version: entry.server.version ?? '',
      packages: (entry.server.packages ?? [])
        .filter((p) => p.registryType && p.identifier)
        .map((p) => `${p.registryType}:${p.identifier}`),
      remotes: [
        ...new Set(
          (entry.server.remotes ?? []).map((r) => r.type ?? '').filter(Boolean),
        ),
      ],
      publishedAt: meta.publishedAt ?? '',
    };
    const info = byRepo.get(key) ?? {
      repo,
      servers: [],
      hasPackages: false,
      newest: '',
    };
    info.servers.push(server);
    info.hasPackages ||= server.packages.length > 0;
    if (server.publishedAt > info.newest) info.newest = server.publishedAt;
    byRepo.set(key, info);
  }
  report.repos = byRepo.size;

  // — Orden de las consultas: pendientes, luego con paquetes, luego solo remotos; recientes primero —
  type Work = { repo: string; nota: string; origins: Origin[] };
  const work = new Map<string, Work>();
  for (const p of previous.pending) {
    work.set(p.repo.toLowerCase(), { repo: p.repo, nota: p.nota, origins: [] });
  }
  const originsOf = (info: RepoInfo): Origin[] =>
    info.servers.slice(0, 3).map((s) => ({
      categoria: options.categoria,
      tipo: 'registry' as const,
      query: s.name,
    }));
  const infos = [...byRepo.values()].sort(
    (a, b) =>
      Number(b.hasPackages) - Number(a.hasPackages) ||
      (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0),
  );
  for (const info of infos) {
    const key = info.repo.toLowerCase();
    const sorted = [...info.servers].sort((a, b) =>
      a.publishedAt < b.publishedAt ? 1 : -1,
    );
    work.set(key, {
      repo: info.repo,
      nota: registryNote(sorted),
      origins: originsOf({ ...info, servers: sorted }),
    });
  }
  const ordered = [...work.values()];
  const lookups = ordered.slice(0, maxLookups);
  report.omitidos = ordered.length - lookups.length;
  const pending = new Map<string, { repo: string; nota: string }>();
  for (const w of ordered.slice(maxLookups)) {
    // Lo omitido por el tope solo se guarda si venía ya como pendiente: el caudal nuevo no se arrastra.
    if (
      previous.pending.some(
        (p) => p.repo.toLowerCase() === w.repo.toLowerCase(),
      )
    ) {
      pending.set(w.repo.toLowerCase(), { repo: w.repo, nota: w.nota });
    }
  }

  // — Etapa 1: estrellas —
  const stars = new Map<string, number>();
  const limit = pLimit(GRAPHQL_CONCURRENCY);
  const gone = new Set<string>();
  const failed = new Set<string>();
  const batches = (list: Work[]) => {
    const out: Work[][] = [];
    for (let i = 0; i < list.length; i += GRAPHQL_BATCH)
      out.push(list.slice(i, i + GRAPHQL_BATCH));
    return out;
  };
  await Promise.all(
    batches(lookups).map((batch) =>
      limit(async () => {
        if (Date.now() > deadline) {
          for (const w of batch) failed.add(w.repo.toLowerCase());
          return;
        }
        const res = await queryRepoBatch(
          octokit,
          batch.map((w) => w.repo),
          STARS_FIELDS,
        );
        stats.lotes++;
        stats.puntos += res.cost;
        for (const [name, repo] of res.repos) {
          if (repo) stars.set(name, repo.stargazerCount);
          else gone.add(name);
        }
        for (const name of res.failed) failed.add(name.toLowerCase());
      }),
    ),
  );
  report.consultados = lookups.length - failed.size;
  report.desaparecidos = gone.size;

  // — Etapa 2: detalle de los que llegan al mínimo —
  const passing = lookups.filter(
    (w) => (stars.get(w.repo.toLowerCase()) ?? -1) >= options.minStars,
  );
  report.conEstrellas = passing.length;
  const detail = passing.slice(0, maxDetails);
  for (const w of passing.slice(maxDetails))
    pending.set(w.repo.toLowerCase(), { repo: w.repo, nota: w.nota });
  for (const key of failed) {
    const w = work.get(key);
    if (w) pending.set(key, { repo: w.repo, nota: w.nota });
  }

  const draft = draftOf([]);
  const repos: McpRegistryResult['repos'] = [];
  await Promise.all(
    batches(detail).map((batch) =>
      limit(async () => {
        if (Date.now() > deadline) {
          for (const w of batch)
            pending.set(w.repo.toLowerCase(), { repo: w.repo, nota: w.nota });
          return;
        }
        const res = await queryRepoBatch(
          octokit,
          batch.map((w) => w.repo),
          REPO_FIELDS,
        );
        stats.lotes++;
        stats.puntos += res.cost;
        for (const w of batch) {
          const key = w.repo.toLowerCase();
          const found = res.repos.get(key);
          if (found) {
            const repo = toGithubRepo(found);
            draft.resolved.set(key, repo.full_name.toLowerCase());
            repos.push({
              repo,
              // un repo que viene solo como pendiente no trae servidores en esta ventana
              origins:
                w.origins.length > 0
                  ? w.origins
                  : [
                      {
                        categoria: options.categoria,
                        tipo: 'registry',
                        query: REGISTRY_ID,
                      },
                    ],
              notes: [w.nota],
            });
          } else if (found === null) {
            report.desaparecidos++;
          } else {
            pending.set(key, { repo: w.repo, nota: w.nota });
          }
        }
      }),
    ),
  );
  report.detallados = repos.length;
  report.pendientes = pending.size;

  const finalPending = [...pending.values()].slice(0, MAX_PENDING);
  draft.snapshot = { ...draft.snapshot, pending: finalPending };
  draft.notas = new Map(
    [...work].map(([k, w]) => [k, { repo: w.repo, nota: w.nota }] as const),
  );
  if (stats.lotes > 0 && report.consultados === 0 && lookups.length > 0) {
    errors.push({
      source: MCP_SOURCE_ID,
      query: REGISTRY_ID,
      message:
        'Ninguna consulta GraphQL a GitHub funcionó; los repos vuelven la semana siguiente',
    });
  }
  report.estado = rows.length > 0 ? 'con-cambios' : 'sin-cambios';
  return result(repos, [draft]);
}

/**
 * Estado definitivo. Los candidatos que el tope `enrich_max` difirió (`deferred`,
 * `full_name` en minúsculas) no se dan por vistos: vuelven como pendientes.
 */
export function finalizeMcpRegistryState(
  result: McpRegistryResult,
  deferred: Iterable<string>,
): SnapshotWrite<McpRegistryState>[] {
  const deferredNames = new Set(deferred);
  return result.drafts.map((draft) => {
    const pending = new Map(
      draft.snapshot.pending.map((p) => [p.repo.toLowerCase(), p]),
    );
    for (const [key, name] of draft.resolved) {
      const note = draft.notas.get(key);
      if (deferredNames.has(name) && note) pending.set(key, note);
    }
    return {
      file: draft.file,
      existed: draft.existed,
      snapshot: {
        ...draft.snapshot,
        pending: [...pending.values()].slice(0, MAX_PENDING),
      },
    };
  });
}

/** Escribe el estado de `data/mcp-registry/` (ver `writeSnapshots`). */
export const writeMcpRegistryState = writeSnapshots;
