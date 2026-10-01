import crypto from 'node:crypto';
import path from 'node:path';
import pLimit from 'p-limit';
import yaml from 'yaml';
import { z } from 'zod';
import type { Origin } from '../normalize/candidate.js';
import { createGithubClient, requireToken } from './github-client.js';
import {
  COLLECTOR_TIMEOUT_MS,
  type GithubRepo,
  type SourceError,
} from './github.js';
import { resolveGithubRepo } from './resolve-repo.js';
import {
  type SnapshotWrite,
  readSnapshotFile,
  snapshotFileName,
  writeSnapshots,
} from './snapshots.js';

export const ANTHROPIC_SOURCE_ID = 'anthropic-skills';
export const SKILLS_REPO = 'anthropics/skills';
export const MARKETPLACE_REPO = 'anthropics/claude-plugins-official';
const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
const RAW_ACCEPT = 'application/vnd.github.raw+json';
/** Commits que se listan de `anthropics/skills`; si hay más desde la última vez, se dice. */
export const SKILLS_COMMITS_PAGE = 20;
/** Plugins nuevos del marketplace que se resuelven a repo por recogida; el resto vuelve la semana siguiente. */
export const MAX_NEW_PLUGIN_REPOS = 50;
/** `SKILL.md` de skills nuevas que se leen para poner su descripción en el changelog. */
const MAX_SKILL_DESCRIPTIONS = 20;
const RESOLVE_CONCURRENCY = 4;

type Watched = { repo: string; kind: 'skills' | 'plugins'; perPage: number };
/**
 * Fuentes.md: `anthropics/skills` y el marketplace oficial de plugins de Claude
 * Code. Ninguno publica releases ni tags (verificado el 2026-10-01): la señal
 * son los commits (skills) y el diff del catálogo (ambos). Del marketplace solo
 * hace falta saber si HEAD se movió, así que se pide un commit.
 */
const WATCHED: Watched[] = [
  { repo: SKILLS_REPO, kind: 'skills', perPage: SKILLS_COMMITS_PAGE },
  { repo: MARKETPLACE_REPO, kind: 'plugins', perPage: 1 },
];

/** Lo que se recuerda de cada repo entre semanas. */
export const anthropicSnapshotSchema = z
  .object({
    version: z.literal(1),
    repo: z.string().min(1),
    /** ETag del listado de commits; `null` si hay pendientes: obliga a mirar de nuevo. */
    etag: z.string().nullable(),
    /** HEAD cuando se guardó: de aquí salen «los commits desde la última vez». */
    head: z.string().min(1),
    fetchedAt: z.string(),
    /** skills: directorio → sha de su árbol; plugins: nombre → huella de su entrada. */
    items: z.record(z.string()),
  })
  .strict();

export type AnthropicSnapshot = z.infer<typeof anthropicSnapshotSchema>;

export const anthropicSnapshotPath = (snapshotDir: string, repo: string) =>
  path.join(snapshotDir, snapshotFileName(repo));

const marketplaceSchema = z
  .object({
    plugins: z.array(
      z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
          homepage: z.string().optional(),
          source: z
            .union([z.string(), z.object({ source: z.string() }).passthrough()])
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type PluginEntry = z.infer<typeof marketplaceSchema>['plugins'][number];

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Huella de una entrada del marketplace sin `source.sha` ni `source.ref`: cada
 * plugin externo fija el commit que Anthropic ha revisado y esos pines se mueven
 * en bloque (126 «cambios» en dos semanas frente a 6 reales, medido el
 * 2026-10-01); lo que cuenta es que cambie la descripción, la categoría o el origen.
 */
export function pluginDigest(entry: unknown): string {
  const clone = structuredClone(entry) as Record<string, unknown>;
  const source = clone.source;
  if (source && typeof source === 'object') {
    const { sha: _sha, ref: _ref, ...rest } = source as Record<string, unknown>;
    clone.source = rest;
  }
  return crypto
    .createHash('sha1')
    .update(stableStringify(clone))
    .digest('hex')
    .slice(0, 12);
}

const GITHUB_URL =
  /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** Dónde vive un plugin y, si es un repo de GitHub, cuál (`owner/repo` en minúsculas). */
export function pluginLocation(entry: PluginEntry): {
  url: string;
  githubRepo: string | null;
} {
  const source = entry.source;
  if (typeof source === 'string' && source.startsWith('./')) {
    return {
      url: `https://github.com/${MARKETPLACE_REPO}/tree/HEAD/${source.replace(/^\.\//, '').replace(/\/$/, '')}`,
      githubRepo: null,
    };
  }
  const url =
    source && typeof source === 'object' && typeof source.url === 'string'
      ? source.url
      : undefined;
  const match = url ? GITHUB_URL.exec(url) : null;
  if (match) {
    return {
      url: `https://github.com/${match[1]}/${match[2]}`,
      githubRepo: `${match[1]}/${match[2]}`.toLowerCase(),
    };
  }
  return {
    url: entry.homepage ?? `https://github.com/${MARKETPLACE_REPO}`,
    githubRepo: null,
  };
}

/** `description` del frontmatter de un `SKILL.md` (el YAML puede venir plegado con `>`). */
export function skillDescription(markdown: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return undefined;
  try {
    const data = yaml.parse(match[1]) as { description?: unknown };
    return typeof data?.description === 'string'
      ? data.description.replace(/\s+/g, ' ').trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export type OfficialChange = {
  tipo: 'skill' | 'plugin';
  cambio: 'nuevo' | 'actualizado' | 'eliminado';
  nombre: string;
  descripcion?: string;
  url: string;
};

export type OfficialCommit = { sha: string; fecha: string; mensaje: string };

/** Changelog de un repo oficial desde la última ejecución (va al fichero de la semana y al informe). */
export type OfficialEntry = {
  fuente: string;
  desde: string;
  hasta: string;
  commits: OfficialCommit[];
  /** Hay más commits de los que se listan (o el anterior ya no está en la página). */
  masCommits: boolean;
  cambios: OfficialChange[];
};

export type AnthropicSourceReport = {
  repo: string;
  estado: 'primera-pasada' | 'sin-cambios' | 'con-cambios' | 'error';
  /** Skills o plugins que hay ahora; `null` si no se miró (304 o error). */
  items: number | null;
  nuevos: number;
  actualizados: number;
  eliminados: number;
  /** Plugins nuevos resueltos a un repo de GitHub (candidatos). */
  resueltos: number;
  desaparecidos: number;
  /** Plugins nuevos que vuelven la próxima semana: por encima del tope o con un error transitorio. */
  pendientes: number;
};

type Draft = {
  file: string;
  existed: boolean;
  snapshot: AnthropicSnapshot;
  pending: Set<string>;
  /** Plugin → `full_name` en minúsculas del repo al que resolvió. */
  resolved: Map<string, string>;
};

export type AnthropicResult = {
  repos: { repo: GithubRepo; origins: Origin[] }[];
  oficiales: OfficialEntry[];
  errors: SourceError[];
  sources: AnthropicSourceReport[];
  stats: {
    requests: number;
    notModified: number;
    cambios: number;
    resueltos: number;
    pendientes: number;
  };
  drafts: Draft[];
};

export type CollectAnthropicOptions = {
  token: string | undefined;
  now?: Date;
  /** `data/anthropic`. */
  snapshotDir: string;
  /**
   * Categoría (de `Intereses.md`) de los repos de los plugins nuevos del marketplace.
   * Sin ella el colector solo lleva el changelog y no propone candidatos.
   */
  categoria?: string;
  logger?: (message: string) => void;
  deadlineMs?: number;
  maxNewPluginRepos?: number;
  /** Solo tests. */
  throttle?: boolean;
  retryBaseMs?: number;
};

type RawCommit = {
  sha: string;
  commit: { message: string; committer?: { date?: string } | null };
};

const statusOf = (err: unknown) => (err as { status?: number }).status;
const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
const rawText = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  throw new Error('GitHub no devolvió el fichero como texto');
};
const order: Record<OfficialChange['cambio'], number> = {
  nuevo: 0,
  actualizado: 1,
  eliminado: 2,
};

/**
 * Colector `anthropic-skills` (Fuentes.md): qué ha cambiado desde la última
 * ejecución en `anthropics/skills` y en el marketplace oficial de plugins de
 * Claude Code (`anthropics/claude-plugins-official`).
 *
 * - Primero se pide el listado de commits con `If-None-Match`: un `304` (nada
 *   nuevo) cuesta 0 peticiones. Si HEAD se movió se lee el estado en HEAD:
 *   los directorios de `skills/` (con el sha de su árbol) o `marketplace.json`.
 * - Se compara con la instantánea de `data/anthropic/`. Resultado: un changelog
 *   (skills y plugins nuevos, actualizados, eliminados, y los commits de
 *   `anthropics/skills`) y, para cada plugin nuevo que vive en su propio repo de
 *   GitHub, ese repo como candidato (origen `anthropic`). Lo que vive dentro de
 *   los repos de Anthropic es changelog, no candidato: `anthropics/skills` está
 *   en `excluir` precisamente porque se sigue por aquí.
 * - Primera pasada (sin instantánea): solo se anota el estado; ni changelog ni candidatos.
 * - No escribe nada: devuelve borradores para `writeSnapshots`, que el pipeline
 *   llama al final de la recogida (como `awesome-list`).
 */
export async function collectFromAnthropic(
  options: CollectAnthropicOptions,
): Promise<AnthropicResult> {
  const token = requireToken(options.token);
  const now = options.now ?? new Date();
  const { octokit, stats: client } = createGithubClient({
    token,
    logger: options.logger,
    throttle: options.throttle,
    retryBaseMs: options.retryBaseMs,
  });

  const deadline = Date.now() + (options.deadlineMs ?? COLLECTOR_TIMEOUT_MS);
  let budget = options.maxNewPluginRepos ?? MAX_NEW_PLUGIN_REPOS;
  const byRepo = new Map<string, { repo: GithubRepo; origins: Origin[] }>();
  const errors: SourceError[] = [];
  const reports: AnthropicSourceReport[] = [];
  const oficiales: OfficialEntry[] = [];
  const drafts: Draft[] = [];
  let notModified = 0;

  for (const watched of WATCHED) {
    const [owner, repo] = watched.repo.split('/');
    const report: AnthropicSourceReport = {
      repo: watched.repo,
      estado: 'error',
      items: null,
      nuevos: 0,
      actualizados: 0,
      eliminados: 0,
      resueltos: 0,
      desaparecidos: 0,
      pendientes: 0,
    };
    reports.push(report);

    if (Date.now() > deadline) {
      errors.push({
        source: ANTHROPIC_SOURCE_ID,
        query: watched.repo,
        message: 'Timeout del colector: repo sin revisar',
      });
      continue;
    }

    try {
      const file = anthropicSnapshotPath(options.snapshotDir, watched.repo);
      const previous = await readSnapshotFile(
        file,
        watched.repo,
        anthropicSnapshotSchema,
      );

      let commits: RawCommit[];
      let etag: string | null;
      try {
        const res = await octokit.request('GET /repos/{owner}/{repo}/commits', {
          owner,
          repo,
          per_page: watched.perPage,
          headers: previous?.etag ? { 'if-none-match': previous.etag } : {},
        });
        commits = res.data as unknown as RawCommit[];
        etag = res.headers.etag ?? null;
      } catch (err) {
        if (statusOf(err) === 304) {
          notModified++;
          report.estado = 'sin-cambios';
          continue;
        }
        throw err;
      }
      const head = commits[0]?.sha;
      if (!head) throw new Error('el repo no tiene commits');

      // Estado en HEAD: nombre → huella (y la entrada, para los plugins).
      const state = new Map<string, { digest: string; entry?: PluginEntry }>();
      if (watched.kind === 'skills') {
        const res = await octokit.request(
          'GET /repos/{owner}/{repo}/contents/{path}',
          { owner, repo, path: 'skills', ref: head },
        );
        for (const item of res.data as unknown as {
          name: string;
          type: string;
          sha: string;
        }[]) {
          if (item.type === 'dir') state.set(item.name, { digest: item.sha });
        }
      } else {
        const res = await octokit.request(
          'GET /repos/{owner}/{repo}/contents/{path}',
          {
            owner,
            repo,
            path: MARKETPLACE_FILE,
            ref: head,
            headers: { accept: RAW_ACCEPT },
          },
        );
        const parsed = marketplaceSchema.safeParse(
          JSON.parse(rawText(res.data)),
        );
        if (!parsed.success) {
          throw new Error(`${MARKETPLACE_FILE} no tiene la forma esperada`);
        }
        for (const entry of parsed.data.plugins) {
          state.set(entry.name, { digest: pluginDigest(entry), entry });
        }
      }
      report.items = state.size;

      const items = Object.fromEntries(
        [...state].map(([name, { digest }]) => [name, digest]),
      );
      const draft: Draft = {
        file,
        existed: previous !== null,
        snapshot: {
          version: 1,
          repo: watched.repo,
          etag,
          head,
          fetchedAt: now.toISOString(),
          items,
        },
        pending: new Set(),
        resolved: new Map(),
      };
      drafts.push(draft);

      if (!previous) {
        report.estado = 'primera-pasada';
        continue;
      }

      const known = previous.items;
      const added = [...state.keys()].filter((n) => !(n in known));
      const removed = Object.keys(known).filter((n) => !state.has(n));
      const changed = [...state.keys()].filter(
        (n) => n in known && known[n] !== state.get(n)?.digest,
      );
      report.nuevos = added.length;
      report.eliminados = removed.length;
      report.actualizados = changed.length;

      const tipo = watched.kind === 'skills' ? 'skill' : 'plugin';
      const baseUrl = (name: string) =>
        `https://github.com/${watched.repo}/tree/HEAD/skills/${name}`;
      const cambios: OfficialChange[] = [];
      const urlOf = (name: string) => {
        const entry = state.get(name)?.entry;
        return entry ? pluginLocation(entry).url : baseUrl(name);
      };

      // Descripciones de las skills nuevas: están en el frontmatter de su SKILL.md.
      const descriptions = new Map<string, string>();
      if (watched.kind === 'skills') {
        const limit = pLimit(RESOLVE_CONCURRENCY);
        await Promise.all(
          added.slice(0, MAX_SKILL_DESCRIPTIONS).map((name) =>
            limit(async () => {
              try {
                const res = await octokit.request(
                  'GET /repos/{owner}/{repo}/contents/{path}',
                  {
                    owner,
                    repo,
                    path: `skills/${name}/SKILL.md`,
                    ref: head,
                    headers: { accept: RAW_ACCEPT },
                  },
                );
                const text = skillDescription(rawText(res.data));
                if (text) descriptions.set(name, text);
              } catch (err) {
                if (statusOf(err) === 401) throw err;
                // Sin descripción: el changelog sigue valiendo.
              }
            }),
          ),
        );
      }

      for (const name of added) {
        cambios.push({
          tipo,
          cambio: 'nuevo',
          nombre: name,
          descripcion:
            descriptions.get(name) ?? state.get(name)?.entry?.description,
          url: urlOf(name),
        });
      }
      for (const name of changed) {
        cambios.push({
          tipo,
          cambio: 'actualizado',
          nombre: name,
          descripcion: state.get(name)?.entry?.description,
          url: urlOf(name),
        });
      }
      for (const name of removed) {
        cambios.push({
          tipo,
          cambio: 'eliminado',
          nombre: name,
          url:
            watched.kind === 'skills'
              ? baseUrl(name)
              : `https://github.com/${watched.repo}`,
        });
      }
      cambios.sort(
        (a, b) =>
          order[a.cambio] - order[b.cambio] || a.nombre.localeCompare(b.nombre),
      );

      // Candidatos: plugins nuevos que viven en su propio repo de GitHub.
      if (watched.kind === 'plugins' && options.categoria) {
        const origin = (name: string): Origin => ({
          categoria: options.categoria as string,
          tipo: 'anthropic',
          query: `${MARKETPLACE_REPO}:${name}`,
        });
        const candidates = added
          .map((name) => ({
            name,
            link: pluginLocation(state.get(name)?.entry as PluginEntry)
              .githubRepo,
          }))
          .filter((c): c is { name: string; link: string } => c.link !== null);
        const cap = Math.max(0, budget);
        budget -= Math.min(cap, candidates.length);
        for (const over of candidates.slice(cap)) draft.pending.add(over.name);
        const limit = pLimit(RESOLVE_CONCURRENCY);
        const outcomes = await Promise.all(
          candidates.slice(0, cap).map((c) =>
            limit(async () => ({
              name: c.name,
              resolution:
                Date.now() > deadline
                  ? ({ kind: 'error', link: c.link } as const)
                  : await resolveGithubRepo(octokit, c.link),
            })),
          ),
        );
        const failed: string[] = [];
        for (const { name, resolution } of outcomes) {
          if (resolution.kind === 'ok') {
            report.resueltos++;
            const key = resolution.repo.full_name.toLowerCase();
            draft.resolved.set(name, key);
            const existing = byRepo.get(key);
            if (existing) existing.origins.push(origin(name));
            else
              byRepo.set(key, {
                repo: resolution.repo,
                origins: [origin(name)],
              });
          } else if (resolution.kind === 'gone') {
            report.desaparecidos++;
          } else {
            draft.pending.add(name);
            failed.push(name);
          }
        }
        if (failed.length > 0) {
          errors.push({
            source: ANTHROPIC_SOURCE_ID,
            query: watched.repo,
            message: `${failed.length} plugins sin resolver (vuelven la próxima semana): ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`,
          });
        }
      }
      report.pendientes = draft.pending.size;
      report.estado = cambios.length > 0 ? 'con-cambios' : 'sin-cambios';

      // Commits desde la última vez (solo de skills: los del marketplace son ruido de PRs).
      const at = commits.findIndex((c) => c.sha === previous.head);
      const since = at >= 0 ? commits.slice(0, at) : commits;
      const listed =
        watched.kind === 'skills'
          ? since.map((c) => ({
              sha: c.sha.slice(0, 7),
              fecha: (c.commit.committer?.date ?? '').slice(0, 10),
              mensaje: c.commit.message.split('\n')[0].trim(),
            }))
          : [];
      if (cambios.length > 0 || listed.length > 0) {
        oficiales.push({
          fuente: watched.repo,
          desde: previous.head.slice(0, 7),
          hasta: head.slice(0, 7),
          commits: listed,
          masCommits:
            watched.kind === 'skills' &&
            at < 0 &&
            commits.length >= watched.perPage,
          cambios,
        });
        if (listed.length > 0 && cambios.length === 0) {
          report.estado = 'con-cambios';
        }
      }
    } catch (err) {
      if (statusOf(err) === 401) {
        throw new Error(
          'GITHUB_TOKEN rechazado por GitHub (401): el token es inválido o ha caducado.',
        );
      }
      report.estado = 'error';
      errors.push({
        source: ANTHROPIC_SOURCE_ID,
        query: watched.repo,
        message: messageOf(err),
      });
    }
  }

  return {
    repos: [...byRepo.values()],
    oficiales,
    errors,
    sources: reports,
    stats: {
      requests: client.requests,
      notModified,
      cambios: reports.reduce(
        (n, r) => n + r.nuevos + r.actualizados + r.eliminados,
        0,
      ),
      resueltos: reports.reduce((n, r) => n + r.resueltos, 0),
      pendientes: reports.reduce((n, r) => n + r.pendientes, 0),
    },
    drafts,
  };
}

/**
 * Instantáneas definitivas. Los plugins que el tope `enrich_max` difirió
 * (`deferred`, `full_name` en minúsculas) no se dan por vistos, igual que en
 * `github-search`: siguen siendo «nuevos» la semana siguiente. Con algo pendiente
 * se guarda `etag: null` para que el listado de commits no conteste `304`.
 */
export function finalizeAnthropicSnapshots(
  result: AnthropicResult,
  deferred: Iterable<string>,
): SnapshotWrite<AnthropicSnapshot>[] {
  const deferredNames = new Set(deferred);
  return result.drafts.map((draft) => {
    const pending = new Set(draft.pending);
    for (const [plugin, name] of draft.resolved) {
      if (deferredNames.has(name)) pending.add(plugin);
    }
    return {
      file: draft.file,
      existed: draft.existed,
      snapshot: {
        ...draft.snapshot,
        etag: pending.size > 0 ? null : draft.snapshot.etag,
        items: Object.fromEntries(
          Object.entries(draft.snapshot.items).filter(
            ([name]) => !pending.has(name),
          ),
        ),
      },
    };
  });
}

/** Escribe las instantáneas de `data/anthropic/` (ver `writeSnapshots`). */
export const writeAnthropicSnapshots = writeSnapshots;
