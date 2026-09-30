import {
  REQUEST_TIMEOUT_MS,
  USER_AGENT,
  requireToken,
} from './github-client.js';

export const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';

export type RateLimitBucket = {
  limit: number;
  remaining: number;
  /** Cuándo se renueva la ventana, en ISO 8601. */
  reset: string;
};

/** Los dos cubos que usa el pipeline: `search` (búsquedas) y `core` (enrich). */
export type RateLimits = { core: RateLimitBucket; search: RateLimitBucket };

export type RateLimitMinimums = {
  /** Peticiones `core` que deben quedar ahora. */
  core?: number;
  /** Límite por minuto del cubo `search`. */
  search?: number;
};

type RawBucket = { limit?: unknown; remaining?: unknown; reset?: unknown };

function bucket(name: string, raw: RawBucket | undefined): RateLimitBucket {
  const { limit, remaining, reset } = raw ?? {};
  if (
    typeof limit !== 'number' ||
    typeof remaining !== 'number' ||
    typeof reset !== 'number'
  ) {
    throw new Error(
      `GET /rate_limit no trae el cubo "${name}" con el formato esperado.`,
    );
  }
  return { limit, remaining, reset: new Date(reset * 1000).toISOString() };
}

/**
 * `GET /rate_limit` con el token dado. No consume cuota. Con un PAT *fine-grained*
 * se vio devolver `used: 0` y `remaining` sin descontar tras cientos de peticiones, así
 * que un valor bajo es fiable y uno alto no garantiza nada: el gasto real se mide con las
 * cabeceras `x-ratelimit-*` de una respuesta normal. El `limit` sí es el del token.
 */
export async function fetchRateLimits(
  token: string | undefined,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<RateLimits> {
  const auth = requireToken(token);
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(RATE_LIMIT_URL, {
    headers: {
      authorization: `Bearer ${auth}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });

  if (res.status === 401) {
    throw new Error(
      'GITHUB_TOKEN rechazado por GitHub (401): el token es inválido o ha caducado.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `GET /rate_limit respondió ${res.status} ${res.statusText}`.trim(),
    );
  }
  const body = (await res.json()) as {
    resources?: Record<string, RawBucket>;
  };
  return {
    core: bucket('core', body.resources?.core),
    search: bucket('search', body.resources?.search),
  };
}

/**
 * Lo que falta para una recogida: a `core` le tienen que quedar al menos `min.core`
 * peticiones y el límite de `search` tiene que ser de al menos `min.search` por minuto
 * (el throttling las reparte; solo importa que el límite no sea el de sin token).
 * Devuelve los problemas; una lista vacía significa que alcanza.
 */
export function checkRateLimits(
  limits: RateLimits,
  min: RateLimitMinimums,
): string[] {
  const problems: string[] = [];
  if (min.core !== undefined && limits.core.remaining < min.core) {
    problems.push(
      `core: quedan ${limits.core.remaining} de ${limits.core.limit} peticiones por hora y hacen falta ${min.core}`,
    );
  }
  if (min.search !== undefined && limits.search.limit < min.search) {
    problems.push(
      `search: el límite es de ${limits.search.limit} por minuto y hacen falta ${min.search}`,
    );
  }
  return problems;
}

/** Líneas legibles; no incluyen nada del token. */
export function formatRateLimits(limits: RateLimits): string[] {
  const line = (name: string, b: RateLimitBucket, unit: string) =>
    `  ${name.padEnd(6)} límite ${b.limit} por ${unit} · quedan ${b.remaining} · se renueva ${b.reset}`;
  return [
    'Cuota de la API de GitHub (GET /rate_limit)',
    line('core', limits.core, 'hora'),
    line('search', limits.search, 'minuto'),
  ];
}
