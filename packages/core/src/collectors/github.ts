import type { Interests } from '../config/schema.js';
import { createGithubClient, requireToken } from './github-client.js';

export const SOURCE_ID = 'github-search';
export const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const PER_PAGE = 30;

/** Campos del repositorio de la API de búsqueda que usa el resto del pipeline. */
export type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  license: { key: string; name: string; spdx_id: string | null } | null;
  topics?: string[];
  archived: boolean;
  fork: boolean;
  default_branch: string;
  owner: { login: string };
};

/** De qué consulta salió un repositorio (para `categoriaSugerida`). */
export type Origin = {
  categoria: string;
  tipo: 'keyword' | 'topic';
  query: string;
};

export type GithubQuery = { q: string; origins: Origin[] };
export type SourceError = { source: string; query?: string; message: string };

export type GithubSearchResult = {
  repos: { repo: GithubRepo; origins: Origin[] }[];
  errors: SourceError[];
  stats: {
    queries: number;
    executed: number;
    requests: number;
    cacheHits: number;
    rawItems: number;
    uniqueRepos: number;
  };
};

export type CollectGithubOptions = {
  token: string | undefined;
  interests: Interests;
  now?: Date;
  /** Directorio de la caché HTTP de 24 h (`data/cache/github`). */
  cacheDir?: string;
  logger?: (message: string) => void;
  deadlineMs?: number;
  /** Solo tests. */
  throttle?: boolean;
  retryBaseMs?: number;
};

/** `YYYY-MM-DD` (UTC) de hace `days` días. */
export function sinceDate(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Consultas de Fuentes.md derivadas de Intereses:
 * - keyword: `"<kw>" created:>SINCE stars:>=MIN` (novedades)
 * - topic:   `topic:<t> pushed:>SINCE stars:>=MIN` (actividad reciente)
 * `MIN` es la `estrellas_min` de la categoría o, si no tiene, la global. Las
 * consultas idénticas de varias categorías se lanzan una sola vez.
 */
export function buildQueries(interests: Interests, now: Date): GithubQuery[] {
  const since = sinceDate(now, interests.ventana_dias);
  const byQuery = new Map<string, GithubQuery>();

  const add = (q: string, origin: Origin) => {
    const existing = byQuery.get(q);
    if (existing) existing.origins.push(origin);
    else byQuery.set(q, { q, origins: [origin] });
  };

  for (const [categoria, cat] of Object.entries(interests.categorias)) {
    const min = cat.estrellas_min ?? interests.reglas_globales.estrellas_min;
    for (const keyword of cat.keywords) {
      const phrase = keyword.replaceAll('"', '');
      add(`"${phrase}" created:>${since} stars:>=${min}`, {
        categoria,
        tipo: 'keyword',
        query: keyword,
      });
    }
    for (const topic of cat.topics) {
      add(`topic:${topic} pushed:>${since} stars:>=${min}`, {
        categoria,
        tipo: 'topic',
        query: topic,
      });
    }
  }
  return [...byQuery.values()];
}

const statusOf = (err: unknown) => (err as { status?: number }).status;
const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Colector `github-search`. Sin token aborta antes de la primera petición. Una
 * consulta que falla se registra en `errors` sin tumbar la ejecución; un 401 sí
 * la tumba, porque el token inválido afecta a todas las consultas.
 */
export async function collectFromGithub(
  options: CollectGithubOptions,
): Promise<GithubSearchResult> {
  const token = requireToken(options.token);
  const now = options.now ?? new Date();
  const queries = buildQueries(options.interests, now);
  const { octokit, stats } = createGithubClient({
    token,
    cacheDir: options.cacheDir,
    logger: options.logger,
    throttle: options.throttle,
    retryBaseMs: options.retryBaseMs,
  });

  const deadline = Date.now() + (options.deadlineMs ?? COLLECTOR_TIMEOUT_MS);
  const byRepo = new Map<string, { repo: GithubRepo; origins: Origin[] }>();
  const errors: SourceError[] = [];
  let executed = 0;
  let rawItems = 0;

  for (const { q, origins } of queries) {
    if (Date.now() > deadline) {
      errors.push({
        source: SOURCE_ID,
        message: `Timeout del colector: quedaron ${queries.length - executed} consultas sin ejecutar`,
      });
      break;
    }
    executed++;

    try {
      const res = await octokit.request('GET /search/repositories', {
        q,
        sort: 'stars',
        order: 'desc',
        per_page: PER_PAGE,
      });
      const items = (res.data.items ?? []) as GithubRepo[];
      rawItems += items.length;
      if (res.data.incomplete_results) {
        options.logger?.(`Resultados incompletos para: ${q}`);
      }
      for (const repo of items) {
        const key = repo.full_name.toLowerCase();
        const seen = byRepo.get(key);
        if (seen) seen.origins.push(...origins);
        else byRepo.set(key, { repo, origins: [...origins] });
      }
    } catch (err) {
      if (statusOf(err) === 401) {
        throw new Error(
          'GITHUB_TOKEN rechazado por GitHub (401): el token es inválido o ha caducado.',
        );
      }
      errors.push({ source: SOURCE_ID, query: q, message: messageOf(err) });
    }
  }

  return {
    repos: [...byRepo.values()],
    errors,
    stats: {
      queries: queries.length,
      executed,
      requests: stats.requests,
      cacheHits: stats.cacheHits,
      rawItems,
      uniqueRepos: byRepo.size,
    },
  };
}
