import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { Interests } from '../config/schema.js';
import type { Origin } from '../normalize/candidate.js';
import { atomicWriteFile } from '../vault/fsutil.js';
import { createGithubClient, requireToken } from './github-client.js';
import {
  COLLECTOR_TIMEOUT_MS,
  type GithubRepo,
  type SourceError,
} from './github.js';

export const AWESOME_SOURCE_ID = 'awesome-list';
/** Enlaces nuevos que se resuelven por lista y por semana; el resto queda para la siguiente. */
export const MAX_NEW_PER_LIST = 100;
/**
 * Y en total por recogida: con el token automático de Actions (1.000 peticiones/h)
 * nueve listas con 100 enlaces cada una, más el enrich (~240), agotarían la cuota.
 * Lo que no cabe vuelve la semana siguiente, igual que lo que supera el tope por lista.
 */
export const MAX_NEW_PER_RUN = 300;
const RESOLVE_CONCURRENCY = 4;
const RAW_ACCEPT = 'application/vnd.github.raw+json';

/**
 * Primer segmento de una URL de github.com que no es un propietario: páginas del
 * propio sitio (`github.com/topics/solana`, `github.com/sponsors/x`…).
 */
const RESERVED_OWNERS = new Set([
  'about',
  'account',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'customer-stories',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'join',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'security',
  'settings',
  'sitemap',
  'sponsors',
  'topics',
  'trending',
  'users',
]);

const LINK = /https?:\/\/(?:www\.)?github\.com\/([\w-]+)\/([\w.-]+)/gi;

/**
 * Repositorios enlazados desde un README, como `owner/repo` en minúsculas, sin
 * repetidos y en el orden en que aparecen. Solo cuenta `github.com/<owner>/<repo>`
 * (y lo que cuelgue de ahí: `/tree/…`, `#readme`, `.git`); se ignoran las páginas
 * del sitio, los enlaces a la propia lista y todo lo que no es github.com
 * (badges de shields.io, raw.githubusercontent.com, etc.). El README es contenido
 * no confiable: de él solo se extraen estos pares, nada más.
 */
export function extractRepoLinks(markdown: string, selfRepo: string): string[] {
  const self = selfRepo.toLowerCase();
  const found = new Set<string>();
  for (const match of markdown.matchAll(LINK)) {
    const owner = match[1].toLowerCase();
    const repo = match[2]
      .toLowerCase()
      .replace(/\.git$/, '')
      .replace(/\.+$/, '');
    if (!repo || RESERVED_OWNERS.has(owner)) continue;
    const key = `${owner}/${repo}`;
    if (key !== self) found.add(key);
  }
  return [...found];
}

/** Lo que se recuerda de cada lista entre semanas: sus enlaces y la ETag de su README. */
export const awesomeSnapshotSchema = z
  .object({
    version: z.literal(1),
    /** `owner/repo` de la lista, tal y como está en `awesome_listas`. */
    repo: z.string().min(1),
    /** `null` si hay enlaces pendientes: obliga a descargar el README la próxima vez. */
    etag: z.string().nullable(),
    fetchedAt: z.string(),
    /** `owner/repo` en minúsculas, ordenados. */
    links: z.array(z.string()),
  })
  .strict();

export type AwesomeSnapshot = z.infer<typeof awesomeSnapshotSchema>;

export const snapshotPath = (snapshotDir: string, repo: string) =>
  path.join(snapshotDir, `${repo.toLowerCase().replace('/', '-')}.json`);

async function readSnapshot(
  file: string,
  repo: string,
): Promise<AwesomeSnapshot | null> {
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
    throw new Error(`${file} no es JSON válido; no se sobrescribe.`);
  }
  const parsed = awesomeSnapshotSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} no cumple el esquema; no se sobrescribe.`);
  }
  if (parsed.data.repo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(
      `${file} es de ${parsed.data.repo}, no de ${repo} (mismo nombre de fichero); no se sobrescribe.`,
    );
  }
  return parsed.data;
}

export type AwesomeListReport = {
  repo: string;
  categoria: string;
  estado: 'primera-pasada' | 'sin-cambios' | 'con-cambios' | 'error';
  /** Enlaces a repos en el README; `null` si no se descargó (304 o error). */
  enlaces: number | null;
  /** Enlaces que no estaban en la instantánea. */
  nuevos: number;
  /** Enlaces de la instantánea que ya no están en el README. */
  quitados: number;
  /** Nuevos resueltos con `GET /repos/{owner}/{repo}`. */
  resueltos: number;
  /** Nuevos que ya no existen (404, 410, 451): se dan por vistos. */
  desaparecidos: number;
  /** Nuevos que vuelven la próxima semana: por encima del tope o con un error transitorio. */
  pendientes: number;
};

/** Instantánea calculada, aún sin escribir. */
type SnapshotDraft = {
  file: string;
  existed: boolean;
  snapshot: AwesomeSnapshot;
  /** Enlaces nuevos que no se dan por vistos pase lo que pase (tope y errores transitorios). */
  pending: Set<string>;
  /** Enlace → `full_name` en minúsculas del repo al que resolvió (puede haber cambiado de nombre). */
  resolved: Map<string, string>;
};

export type AwesomeResult = {
  repos: { repo: GithubRepo; origins: Origin[] }[];
  errors: SourceError[];
  lists: AwesomeListReport[];
  stats: {
    lists: number;
    requests: number;
    notModified: number;
    nuevos: number;
    resueltos: number;
    pendientes: number;
  };
  drafts: SnapshotDraft[];
};

export type CollectAwesomeOptions = {
  token: string | undefined;
  interests: Interests;
  now?: Date;
  /** `data/awesome`. */
  snapshotDir: string;
  logger?: (message: string) => void;
  deadlineMs?: number;
  maxNewPerList?: number;
  maxNewPerRun?: number;
  /** Solo tests. */
  throttle?: boolean;
  retryBaseMs?: number;
};

const statusOf = (err: unknown) => (err as { status?: number }).status;
const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const GONE = new Set([404, 410, 451]);

type Resolution =
  | { kind: 'ok'; link: string; repo: GithubRepo }
  | { kind: 'gone'; link: string }
  | { kind: 'error'; link: string };

function readmeText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  throw new Error('GitHub no devolvió el README como texto');
}

/**
 * Colector `awesome-list` (Fuentes.md): descarga el README de cada lista de
 * `awesome_listas` en formato `raw` (texto plano, sin base64; la variante JSON solo
 * entrega el contenido hasta 1 MB y el mayor de los nueve, punkpeye/awesome-mcp-servers,
 * ya ocupa 487 KB y crece), con `If-None-Match` para que un `304` no gaste cuota, y
 * lo compara con la instantánea de la semana anterior. Los enlaces
 * nuevos a `github.com/<owner>/<repo>` se resuelven con `GET /repos` y salen como
 * repos para el normalize y los filtros de siempre.
 *
 * - Primera pasada (sin instantánea): solo se anota qué enlaces hay; no hay candidatos.
 * - No escribe nada: devuelve borradores de instantánea para `writeAwesomeSnapshots`,
 *   que el pipeline llama cuando la recogida ya terminó, de modo que un fallo a mitad
 *   no se come las novedades.
 * - Una lista que falla se anota en `errors` y no tumba a las demás; un 401 sí.
 */
export async function collectFromAwesomeLists(
  options: CollectAwesomeOptions,
): Promise<AwesomeResult> {
  const token = requireToken(options.token);
  const now = options.now ?? new Date();
  const lists = Object.entries(options.interests.awesome_listas);
  const perList = options.maxNewPerList ?? MAX_NEW_PER_LIST;
  let budget = options.maxNewPerRun ?? MAX_NEW_PER_RUN;
  // Sin caché en disco: la instantánea y la ETag ya hacen ese trabajo.
  const { octokit, stats: client } = createGithubClient({
    token,
    logger: options.logger,
    throttle: options.throttle,
    retryBaseMs: options.retryBaseMs,
  });

  const deadline = Date.now() + (options.deadlineMs ?? COLLECTOR_TIMEOUT_MS);
  const byRepo = new Map<string, { repo: GithubRepo; origins: Origin[] }>();
  const errors: SourceError[] = [];
  const reports: AwesomeListReport[] = [];
  const drafts: SnapshotDraft[] = [];
  let notModified = 0;

  const resolveLink = async (link: string): Promise<Resolution> => {
    const [owner, repo] = link.split('/');
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}', {
        owner,
        repo,
      });
      return { kind: 'ok', link, repo: res.data as unknown as GithubRepo };
    } catch (err) {
      const status = statusOf(err);
      if (status === 401) throw err;
      if (status !== undefined && GONE.has(status))
        return { kind: 'gone', link };
      return { kind: 'error', link };
    }
  };

  for (const [listRepo, categoria] of lists) {
    const [owner, repo] = listRepo.split('/');
    const report: AwesomeListReport = {
      repo: listRepo,
      categoria,
      estado: 'error',
      enlaces: null,
      nuevos: 0,
      quitados: 0,
      resueltos: 0,
      desaparecidos: 0,
      pendientes: 0,
    };
    reports.push(report);

    if (Date.now() > deadline) {
      errors.push({
        source: AWESOME_SOURCE_ID,
        query: listRepo,
        message: 'Timeout del colector: lista sin revisar',
      });
      continue;
    }

    try {
      const file = snapshotPath(options.snapshotDir, listRepo);
      const previous = await readSnapshot(file, listRepo);

      let text: string;
      let etag: string | null;
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/readme', {
          owner,
          repo,
          headers: {
            accept: RAW_ACCEPT,
            ...(previous?.etag ? { 'if-none-match': previous.etag } : {}),
          },
        });
        text = readmeText(res.data);
        etag = res.headers.etag ?? null;
      } catch (err) {
        if (statusOf(err) === 304) {
          notModified++;
          report.estado = 'sin-cambios';
          continue;
        }
        throw err;
      }

      const links = extractRepoLinks(text, listRepo);
      report.enlaces = links.length;

      const known = new Set(previous?.links ?? []);
      const current = new Set(links);
      const added = previous ? links.filter((l) => !known.has(l)) : [];
      report.quitados = previous
        ? previous.links.filter((l) => !current.has(l)).length
        : 0;
      report.nuevos = added.length;
      report.estado = previous
        ? added.length > 0 || report.quitados > 0
          ? 'con-cambios'
          : 'sin-cambios'
        : 'primera-pasada';

      const cap = Math.min(perList, budget);
      budget -= Math.min(cap, added.length);
      const pending = new Set(added.slice(cap));
      const toResolve = added.slice(0, cap);
      const resolved = new Map<string, string>();
      const failed: string[] = [];
      const limit = pLimit(RESOLVE_CONCURRENCY);
      const outcomes = await Promise.all(
        toResolve.map((link) =>
          limit(async (): Promise<Resolution> => {
            if (Date.now() > deadline) return { kind: 'error', link };
            return resolveLink(link);
          }),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.kind === 'ok') {
          report.resueltos++;
          const key = outcome.repo.full_name.toLowerCase();
          resolved.set(outcome.link, key);
          const origin: Origin = {
            categoria,
            tipo: 'awesome',
            query: listRepo,
          };
          const existing = byRepo.get(key);
          if (existing) existing.origins.push(origin);
          else byRepo.set(key, { repo: outcome.repo, origins: [origin] });
        } else if (outcome.kind === 'gone') {
          report.desaparecidos++;
        } else {
          pending.add(outcome.link);
          failed.push(outcome.link);
        }
      }
      if (failed.length > 0) {
        errors.push({
          source: AWESOME_SOURCE_ID,
          query: listRepo,
          message: `${failed.length} enlaces sin resolver (vuelven la próxima semana): ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
        });
      }
      report.pendientes = pending.size;

      drafts.push({
        file,
        existed: previous !== null,
        snapshot: {
          version: 1,
          repo: listRepo,
          etag,
          fetchedAt: now.toISOString(),
          links: [...current].sort(),
        },
        pending,
        resolved,
      });
    } catch (err) {
      if (statusOf(err) === 401) {
        throw new Error(
          'GITHUB_TOKEN rechazado por GitHub (401): el token es inválido o ha caducado.',
        );
      }
      report.estado = 'error';
      errors.push({
        source: AWESOME_SOURCE_ID,
        query: listRepo,
        message: messageOf(err),
      });
    }
  }

  return {
    repos: [...byRepo.values()],
    errors,
    lists: reports,
    stats: {
      lists: lists.length,
      requests: client.requests,
      notModified,
      nuevos: reports.reduce((n, r) => n + r.nuevos, 0),
      resueltos: reports.reduce((n, r) => n + r.resueltos, 0),
      pendientes: reports.reduce((n, r) => n + r.pendientes, 0),
    },
    drafts,
  };
}

export type SnapshotWrite = {
  file: string;
  existed: boolean;
  snapshot: AwesomeSnapshot;
};

/**
 * Instantáneas definitivas. Los candidatos que el tope `enrich_max` difirió
 * (`deferred`, `full_name` en minúsculas) no se dan por vistos, igual que en
 * `github-search`: su enlace sigue siendo «nuevo» la próxima semana. Si queda algo
 * pendiente se guarda `etag: null` para que el README se descargue de nuevo en
 * vez de contestar `304`.
 */
export function finalizeSnapshots(
  result: AwesomeResult,
  deferred: Iterable<string>,
): SnapshotWrite[] {
  const deferredNames = new Set(deferred);
  return result.drafts.map((draft) => {
    const pending = new Set(draft.pending);
    for (const [link, name] of draft.resolved) {
      if (deferredNames.has(name)) pending.add(link);
    }
    return {
      file: draft.file,
      existed: draft.existed,
      snapshot: {
        ...draft.snapshot,
        etag: pending.size > 0 ? null : draft.snapshot.etag,
        links: draft.snapshot.links.filter((l) => !pending.has(l)),
      },
    };
  });
}

/**
 * Escribe las instantáneas. Con `onlyMissing` (el `--dry-run`) nunca sobrescribe
 * una que ya existe: si lo hiciera, el ensayo se comería las novedades que debe
 * ver la recogida real. Devuelve las que ha escrito.
 */
export async function writeAwesomeSnapshots(
  writes: SnapshotWrite[],
  { onlyMissing = false }: { onlyMissing?: boolean } = {},
): Promise<string[]> {
  const written: string[] = [];
  for (const write of writes) {
    if (onlyMissing && write.existed) continue;
    await fs.mkdir(path.dirname(write.file), { recursive: true });
    await atomicWriteFile(
      write.file,
      `${JSON.stringify(write.snapshot, null, 2)}\n`,
    );
    written.push(write.file);
  }
  return written;
}
