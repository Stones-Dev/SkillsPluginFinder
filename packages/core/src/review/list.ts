import fs from 'node:fs/promises';
import path from 'node:path';
import { batchDir } from '../batch/collect.js';
import { formatZodError } from '../config/interests.js';
import {
  type CatalogEntry,
  type Scoring,
  scoringSchema,
} from '../config/schema.js';
import { WEEK_PATTERN } from '../pipeline/week.js';
import { parseCatalog } from '../vault/catalogo.js';

export type ReviewItem = {
  /** `github:owner/repo`, el id con el que `--prepare` y `--apply` identifican el hallazgo. */
  id: string;
  nombre: string;
  categoria: string;
  score: number | null;
  semana: string;
  /** Proyectos afectados según el scoring de la semana del hallazgo. */
  proyectos: string[];
  url: string | null;
};

export type ReviewList = {
  items: ReviewItem[];
  /** Filas `candidato` sin repositorio deducible: no se pueden revisar. */
  sinRepo: string[];
};

/** Id canónico del hallazgo, el mismo que usa `Candidate.id`. */
export const reviewId = (repo: string) => `github:${repo.toLowerCase()}`;

/** `owner/repo` a partir de un id `github:owner/repo`. */
export function repoFromReviewId(id: string): string {
  const match = id.match(/^github:([\w.-]+\/[\w.-]+)$/i);
  if (!match) {
    throw new Error(
      `Id no válido: "${id}" (se espera github:owner/repo, como el que imprime spf review --list).`,
    );
  }
  return match[1].toLowerCase();
}

/** Filas `candidato` del catálogo con el proyecto afectado de su semana. */
export function reviewCandidates(
  catalog: CatalogEntry[],
  scoringsByWeek: Map<string, Scoring[]>,
): ReviewList {
  const items: ReviewItem[] = [];
  const sinRepo: string[] = [];

  for (const row of catalog) {
    if (row.estado !== 'candidato') continue;
    if (!row.repo) {
      sinRepo.push(row.nombre);
      continue;
    }
    const id = reviewId(row.repo);
    const scoring = scoringsByWeek
      .get(row.semana)
      ?.find((s) => s.candidateId === id);
    items.push({
      id,
      nombre: row.nombre,
      categoria: row.categoria,
      score: row.score,
      semana: row.semana,
      proyectos: scoring?.proyectosAfectados ?? [],
      url: row.enlace,
    });
  }

  items.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      a.semana.localeCompare(b.semana) ||
      a.nombre.localeCompare(b.nombre),
  );
  return { items, sinRepo };
}

/** `data/batches/<week>/scoring.json`, o `[]` si esa semana no tiene. */
export async function readWeekScorings(
  repoDir: string,
  week: string,
): Promise<Scoring[]> {
  const file = path.join(batchDir(repoDir, week), 'scoring.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = scoringSchema.array().safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${file} no cumple el esquema: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Lee `Catalogo.md` del vault y los scorings de cada semana con filas `candidato`. */
export async function listForReview(opts: {
  repoDir: string;
  vaultDir: string;
}): Promise<ReviewList> {
  const text = await fs.readFile(
    path.join(opts.vaultDir, 'Catalogo.md'),
    'utf8',
  );
  const catalog = parseCatalog(text);
  const weeks = new Set(
    catalog
      .filter((e) => e.estado === 'candidato' && WEEK_PATTERN.test(e.semana))
      .map((e) => e.semana),
  );
  const scoringsByWeek = new Map<string, Scoring[]>();
  for (const week of weeks) {
    scoringsByWeek.set(week, await readWeekScorings(opts.repoDir, week));
  }
  return reviewCandidates(catalog, scoringsByWeek);
}

/** Tabla de texto para la terminal. */
export function formatReviewList(list: ReviewList): string[] {
  const { items, sinRepo } = list;
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push('Ningún hallazgo en estado candidato.');
  } else {
    lines.push(
      `${items.length} hallazgo${items.length === 1 ? '' : 's'} en estado candidato`,
    );
    for (const i of items) {
      lines.push(
        '',
        `${i.id}`,
        `  categoría ${i.categoria} · score ${i.score ?? '—'} · ${i.semana}`,
        `  proyectos: ${i.proyectos.length > 0 ? i.proyectos.join(', ') : '—'}`,
        `  ${i.url ?? '—'}`,
      );
    }
  }
  for (const nombre of sinRepo) {
    lines.push(
      '',
      `⚠ "${nombre}" está en candidato pero su enlace no es de GitHub: no se puede revisar con spf review.`,
    );
  }
  return lines;
}
