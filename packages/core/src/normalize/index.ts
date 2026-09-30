import crypto from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { seen } from '../db/schema.js';

export function normalizeCandidate(raw: any) {
  // Base normalization from github search or others
  return {
    id: crypto.randomUUID(),
    name: raw.name || raw.full_name || 'unknown',
    url: raw.html_url || raw.url || '',
    source: raw.source || 'github',
    kind: raw.kind || 'plugin', // or 'skill'
    description: raw.description || '',
    language: raw.language || null,
    stars: raw.stargazers_count || raw.stars || 0,
    forks: raw.forks_count || raw.forks || 0,
    createdAt: raw.created_at || new Date().toISOString(),
    topics: raw.topics || [],
    categoriaSugerida: raw.categoria_sugerida || null,
  };
}

export async function dedupeCandidates(candidates: any[]) {
  const db = getDb();

  if (candidates.length === 0) return [];

  // create dedupe_keys for all candidates. using url as dedupe key for simplicity.
  const dedupeKeys = candidates.map((c) => c.url);

  // check which dedupe_keys already exist in `seen` table
  const existingSeen = await db
    .select()
    .from(seen)
    .where(inArray(seen.dedupeKey, dedupeKeys));
  const existingKeys = new Set(existingSeen.map((s: any) => s.dedupeKey));

  const newCandidates = [];

  for (const c of candidates) {
    if (!existingKeys.has(c.url)) {
      newCandidates.push(c);

      // We don't mark as seen here yet! We only mark as seen when processing the batch or collecting it.
      // But for dedupe step, we just filter them out.
    }
  }

  return newCandidates;
}

export async function markAsSeen(dedupeKeys: string[]) {
  if (dedupeKeys.length === 0) return;
  const db = getDb();

  const values = dedupeKeys.map((k) => ({
    id: crypto.randomUUID(),
    dedupeKey: k,
  }));

  await db.insert(seen).values(values).onConflictDoNothing();
}
