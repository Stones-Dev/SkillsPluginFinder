import crypto from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { GithubRepo } from '../collectors/github.js';
import type { Interests } from '../config/schema.js';
import { type Db, getDb } from '../db/index.js';
import { seen } from '../db/schema.js';
import type { Candidate, Origin } from './candidate.js';

export * from './candidate.js';
export * from './risk.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Kind = Candidate['kind'];

/** Orden de precedencia: mcp > plugin > agent-skill > skill > template. */
function kindFromText(text: string): Kind | null {
  const t = text.toLowerCase();
  if (/\bmcp\b|model context protocol/.test(t)) return 'mcp-server';
  if (/\bplugins?\b/.test(t)) return 'plugin';
  if (/agent[- ]?skills?|agentskills/.test(t)) return 'agent-skill';
  if (/\bskills?\b|skill\.md/.test(t)) return 'skill';
  if (/\b(templates?|boilerplates?|starters?)\b/.test(t)) return 'template';
  return null;
}

/**
 * Tipo de candidato, determinista y sin IA. Manda lo que el repo dice de sí
 * mismo (nombre y descripción); los topics solo deciden si eso no dice nada,
 * porque suelen ser etiquetas de relleno (una guía con el topic `mcp` no es un
 * servidor MCP). Sin señales, `library`.
 */
export function classifyKind(input: {
  name: string;
  description: string;
  topics: string[];
}): Kind {
  return (
    kindFromText(`${input.name} ${input.description}`) ??
    kindFromText(input.topics.join(' ')) ??
    'library'
  );
}

/**
 * `categoriaSugerida` determinista (la IA la confirma o corrige):
 * 3 × consultas de esa categoría de las que salió el repo
 * + 2 × topics del repo que están en los topics de la categoría
 * + 1 × keywords de la categoría presentes en el nombre o la descripción.
 * Empate: mayor `peso`, luego el id de la categoría.
 */
export function suggestCategory(
  input: {
    name: string;
    description: string;
    topics: string[];
    origins: Origin[];
  },
  interests: Interests,
): { categoria: string; alternativas: string[] } {
  const text = `${input.name} ${input.description}`.toLowerCase();
  const topics = new Set(input.topics.map((t) => t.toLowerCase()));

  const scored = Object.entries(interests.categorias).map(([id, cat]) => {
    const fromOrigins = input.origins.filter((o) => o.categoria === id).length;
    const topicHits = cat.topics.filter((t) =>
      topics.has(t.toLowerCase()),
    ).length;
    const keywordHits = cat.keywords.filter((k) =>
      text.includes(k.toLowerCase()),
    ).length;
    return {
      id,
      peso: cat.peso,
      score: 3 * fromOrigins + 2 * topicHits + keywordHits,
    };
  });
  scored.sort(
    (a, b) => b.score - a.score || b.peso - a.peso || a.id.localeCompare(b.id),
  );

  if (scored.length === 0)
    return { categoria: 'sin-categoria', alternativas: [] };
  return {
    categoria: scored[0].id,
    alternativas: scored
      .slice(1)
      .filter((s) => s.score > 0)
      .slice(0, 3)
      .map((s) => s.id),
  };
}

/** Repositorio de la API de GitHub (búsqueda o `GET /repos`) → `Candidate` (Plan §4). */
export function normalizeGithubRepo(
  input: {
    repo: GithubRepo;
    origins: Origin[];
    /** Colector del que salió; por defecto `github-search`. */
    source?: Candidate['source'];
  },
  ctx: { interests: Interests; now: Date },
): Candidate {
  const { repo, origins } = input;
  const description = repo.description ?? '';
  const topics = repo.topics ?? [];
  const suggestion = suggestCategory(
    { name: repo.full_name, description, topics, origins },
    ctx.interests,
  );

  return {
    id: `github:${repo.full_name.toLowerCase()}`,
    name: repo.full_name,
    url: repo.html_url,
    source: input.source ?? 'github-search',
    kind: classifyKind({ name: repo.full_name, description, topics }),
    description,
    language: repo.language ?? undefined,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    createdAt: repo.created_at,
    lastCommitAt: repo.pushed_at,
    license: repo.license?.spdx_id ?? undefined,
    topics,
    archived: repo.archived,
    fork: repo.fork,
    categoriaSugerida: suggestion.categoria,
    categoriasAlternativas: suggestion.alternativas,
    origins,
    risk: {
      ageDays: Math.floor(
        (ctx.now.getTime() - Date.parse(repo.created_at)) / DAY_MS,
      ),
      notes: [],
    },
    foundAt: ctx.now.toISOString(),
  };
}

/** Clave de dedupe: el id estable del candidato. */
export const dedupeKey = (candidate: Pick<Candidate, 'id'>) => candidate.id;

/** Descarta lo que ya está en `seen` (RF-3). Marcar como visto es un paso aparte. */
export async function dedupeCandidates<T extends Pick<Candidate, 'id'>>(
  candidates: T[],
  db: Db = getDb(),
): Promise<T[]> {
  if (candidates.length === 0) return [];
  const keys = candidates.map(dedupeKey);
  const known = await db
    .select()
    .from(seen)
    .where(inArray(seen.dedupeKey, keys));
  const knownKeys = new Set(known.map((s) => s.dedupeKey));
  return candidates.filter((c) => !knownKeys.has(dedupeKey(c)));
}

export async function markAsSeen(dedupeKeys: string[], db: Db = getDb()) {
  if (dedupeKeys.length === 0) return;
  await db
    .insert(seen)
    .values(dedupeKeys.map((k) => ({ id: crypto.randomUUID(), dedupeKey: k })))
    .onConflictDoNothing();
}
