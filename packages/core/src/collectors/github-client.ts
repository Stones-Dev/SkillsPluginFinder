import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Octokit } from '@octokit/core';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

/** Fuentes.md: `SkillsPluginFinder/<versión> (+<repo>)`. */
export const USER_AGENT = `SkillsPluginFinder/${pkg.version} (+https://github.com/Stones-Dev/SkillsPluginFinder)`;
export const REQUEST_TIMEOUT_MS = 30_000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SpfOctokit = Octokit.plugin(throttling, retry);
export type GithubClient = InstanceType<typeof SpfOctokit>;

export class MissingTokenError extends Error {
  constructor() {
    super(
      'GITHUB_TOKEN es obligatorio: sin token GitHub limita a 10 búsquedas por minuto y 60 peticiones por hora, y el pipeline necesita más de 100 búsquedas. ' +
        'Crea un PAT fine-grained de solo lectura de repositorios públicos en https://github.com/settings/personal-access-tokens/new ' +
        'y ponlo en .env (ver .env.example) o en los secrets del entorno.',
    );
    this.name = 'MissingTokenError';
  }
}

/** Aborta antes de la primera petición si no hay token. */
export function requireToken(token: string | undefined): string {
  const trimmed = token?.trim();
  if (!trimmed) throw new MissingTokenError();
  return trimmed;
}

export type ClientOptions = {
  token: string;
  /** Directorio de la caché HTTP de 24 h; sin él no hay caché. */
  cacheDir?: string;
  logger?: (message: string) => void;
  /** `false` desactiva el throttling (solo tests). */
  throttle?: boolean;
  /** Base del backoff de reintentos en ms (por defecto 1000). */
  retryBaseMs?: number;
  requestTimeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
};

export type ClientStats = { requests: number; cacheHits: number };

type CachedResponse = {
  fetchedAt: number;
  response: {
    status: number;
    url: string;
    headers: Record<string, string>;
    data: unknown;
  };
};

const CACHED_HEADERS = ['link', 'content-type'];

async function readCache(
  file: string,
  ttlMs: number,
  now: number,
): Promise<CachedResponse['response'] | null> {
  try {
    const cached = JSON.parse(
      await fsp.readFile(file, 'utf8'),
    ) as CachedResponse;
    return now - cached.fetchedAt < ttlMs ? cached.response : null;
  } catch {
    return null;
  }
}

/**
 * Cliente Octokit con throttling (el grupo `search` respeta los 30 req/min),
 * reintentos ante 5xx, timeout por petición y caché de 24 h de los GET.
 */
export function createGithubClient(options: ClientOptions): {
  octokit: GithubClient;
  stats: ClientStats;
} {
  const log = options.logger ?? (() => {});
  const stats: ClientStats = { requests: 0, cacheHits: 0 };
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const octokit = new SpfOctokit({
    auth: options.token,
    userAgent: USER_AGENT,
    request: {
      // fetch se resuelve en cada llamada: un AbortSignal fijo en el cliente
      // abortaría todas las peticiones posteriores.
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        globalThis.fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeout),
        }),
    },
    throttle: {
      enabled: options.throttle !== false,
      onRateLimit: (retryAfter, opts, _octokit, retryCount) => {
        log(
          `Rate limit en ${opts.method} ${opts.url}: reintento en ${retryAfter}s (intento ${retryCount + 1})`,
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, opts, _octokit, retryCount) => {
        log(
          `Límite secundario en ${opts.method} ${opts.url}: reintento en ${retryAfter}s (intento ${retryCount + 1})`,
        );
        return retryCount < 2;
      },
    },
    retry: { retryAfterBaseValue: options.retryBaseMs ?? 1000 },
  });

  const cacheDir = options.cacheDir;

  // Registrado el último => es el hook más externo: un acierto de caché no
  // pasa por throttling ni por reintentos. `stats.requests` cuenta solo las
  // peticiones lógicas que llegan a la red.
  octokit.hook.wrap('request', async (request, opts) => {
    if (!cacheDir || opts.method !== 'GET') {
      stats.requests++;
      return request(opts);
    }

    const { method, url, headers } = octokit.request.endpoint(opts);
    const key = crypto
      .createHash('sha256')
      .update(`${method} ${url} ${headers.accept ?? ''}`)
      .digest('hex');
    const file = path.join(cacheDir, `${key}.json`);

    const hit = await readCache(file, ttlMs, now());
    if (hit) {
      stats.cacheHits++;
      return hit as never;
    }

    stats.requests++;
    const response = await request(opts);
    const kept: Record<string, string> = {};
    for (const name of CACHED_HEADERS) {
      const value = response.headers[name];
      if (typeof value === 'string') kept[name] = value;
    }
    await fsp.mkdir(cacheDir, { recursive: true });
    const entry: CachedResponse = {
      fetchedAt: now(),
      response: {
        status: response.status,
        url: response.url,
        headers: kept,
        data: response.data,
      },
    };
    await fsp.writeFile(file, JSON.stringify(entry), 'utf8');
    return response;
  });

  return { octokit, stats };
}
