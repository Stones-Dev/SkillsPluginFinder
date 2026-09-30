import fs from 'node:fs/promises';
import path from 'node:path';
import {
  formatZodError,
  loadInterests,
  projectName,
} from '../config/interests.js';
import { type Scoring, scoringSchema } from '../config/schema.js';
import type { Interests } from '../config/schema.js';
import { type Db, getDb } from '../db/index.js';
import { scorings as scoringsTable } from '../db/schema.js';
import type { Candidate } from '../normalize/candidate.js';
import {
  type CandidatesFile,
  readCandidatesFile,
} from '../pipeline/candidates-file.js';
import { assertWeek } from '../pipeline/week.js';
import { HIGH_SCORE, MAX_HIGH_SHARE } from './rubric.js';

export const batchDir = (repoDir: string, week: string) =>
  path.join(repoDir, 'data', 'batches', assertWeek(week));

export type BatchSummary = {
  total: number;
  /** Nº de fichas por score, 1 a 10. */
  distribution: Record<number, number>;
  umbral: number;
  aboveThreshold: number;
  high: number;
};

/** El batch no se acepta: `problems` lista todo lo que hay que corregir de una vez. */
export class BatchRejectedError extends Error {
  constructor(
    readonly week: string,
    readonly problems: string[],
  ) {
    super(
      `Batch ${week} rechazado (${problems.length} problema${problems.length === 1 ? '' : 's'}):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'BatchRejectedError';
  }
}

const list = (items: string[], max = 10) =>
  items.length > max
    ? `${items.slice(0, max).join(', ')} … (+${items.length - max})`
    : items.join(', ');

function summarize(scorings: Scoring[], umbral: number): BatchSummary {
  const distribution: Record<number, number> = {};
  for (let s = 1; s <= 10; s++) distribution[s] = 0;
  for (const s of scorings) distribution[s.score]++;
  return {
    total: scorings.length,
    distribution,
    umbral,
    aboveThreshold: scorings.filter((s) => s.score >= umbral).length,
    high: scorings.filter((s) => s.score >= HIGH_SCORE).length,
  };
}

/**
 * Valida el `scoring.json` del agente contra el batch (RF-5): esquema, semana,
 * ids conocidos y sin duplicar, cobertura completa, categorías y proyectos
 * válidos, y el rechazo por sesgo (más de la mitad de las fichas >= 8). Devuelve
 * todos los problemas a la vez para que el agente los corrija en una pasada.
 */
export function checkScoring(
  raw: unknown,
  ctx: { week: string; candidates: Candidate[]; interests: Interests },
): { scorings: Scoring[]; problems: string[]; summary: BatchSummary } {
  const { week, candidates, interests } = ctx;
  const problems: string[] = [];
  const scorings: Scoring[] = [];

  if (!Array.isArray(raw)) {
    return {
      scorings,
      problems: ['scoring.json debe ser un array JSON con un objeto por ficha'],
      summary: summarize([], interests.umbral_score),
    };
  }

  const known = new Set(candidates.map((c) => c.id));
  const categories = Object.keys(interests.categorias);
  const projects = interests.proyectos.map(projectName);
  const seen = new Set<string>();
  // Una ficha con el esquema roto ya está señalada: no se cuenta también como ausente.
  const covered = new Set<string>();

  raw.forEach((item, index) => {
    const parsed = scoringSchema.safeParse(item);
    if (!parsed.success) {
      const id = (item as { candidateId?: unknown } | null)?.candidateId;
      if (typeof id === 'string') covered.add(id);
      problems.push(
        `[${index}]${typeof id === 'string' ? ` ${id}` : ''}: ${formatZodError(parsed.error)}`,
      );
      return;
    }
    const s = parsed.data;
    const where = `[${index}] ${s.candidateId}`;

    if (s.week !== week)
      problems.push(`${where}: week "${s.week}" no es "${week}"`);
    if (!known.has(s.candidateId)) {
      problems.push(`${where}: no es el id de ninguna ficha de este batch`);
    }
    if (seen.has(s.candidateId)) problems.push(`${where}: id duplicado`);
    if (!categories.includes(s.categoria)) {
      problems.push(
        `${where}: categoria "${s.categoria}" no existe (válidas: ${categories.join(', ')})`,
      );
    }
    for (const p of s.proyectosAfectados) {
      if (!projects.includes(p)) {
        problems.push(
          `${where}: proyecto "${p}" no está en <proyectos>; usa solo el nombre (válidos: ${projects.join(', ')})`,
        );
      }
    }
    seen.add(s.candidateId);
    scorings.push(s);
  });

  const missing = candidates.filter(
    (c) => !seen.has(c.id) && !covered.has(c.id),
  );
  if (missing.length > 0) {
    problems.push(
      `Faltan ${missing.length} de ${candidates.length} fichas: ${list(missing.map((c) => c.name))}`,
    );
  }

  const summary = summarize(scorings, interests.umbral_score);
  if (summary.total > 0 && summary.high / summary.total > MAX_HIGH_SHARE) {
    problems.push(
      `Sesgo: ${summary.high} de ${summary.total} fichas (${Math.round((100 * summary.high) / summary.total)} %) puntúan ${HIGH_SCORE} o más; con más de la mitad el batch se rechaza. Relee la rúbrica y reevalúa`,
    );
  }
  return { scorings, problems, summary };
}

export type ValidatedBatch = {
  scorings: Scoring[];
  summary: BatchSummary;
  candidates: CandidatesFile;
  interests: Interests;
};

/** Lee y valida `data/batches/<week>/scoring.json`; lanza `BatchRejectedError` si algo falla. */
export async function validateBatch(opts: {
  repoDir: string;
  week: string;
}): Promise<ValidatedBatch> {
  const { repoDir } = opts;
  const week = assertWeek(opts.week);
  const candidates = await readCandidatesFile(repoDir, week);
  if (!candidates) {
    throw new Error(
      `No existe data/candidates/${week}.json: no hay batch que validar.`,
    );
  }
  const interests = await loadInterests(repoDir);

  const file = path.join(batchDir(repoDir, week), 'scoring.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No existe ${path.relative(repoDir, file)}: el evaluador debe escribirlo tras leer batch.md.`,
      );
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BatchRejectedError(week, [
      `scoring.json no es JSON válido: ${(err as Error).message}`,
    ]);
  }

  const { scorings, problems, summary } = checkScoring(raw, {
    week,
    candidates: candidates.candidates,
    interests,
  });
  if (problems.length > 0) throw new BatchRejectedError(week, problems);
  return { scorings, summary, candidates, interests };
}

/**
 * `spf collect-batch`: valida y, solo si todo es correcto, guarda los scorings
 * (id `week:candidateId`, upsert: repetirlo tras corregir no duplica nada).
 */
export async function collectBatch(opts: {
  repoDir: string;
  week: string;
  db?: Db;
}): Promise<ValidatedBatch> {
  const validated = await validateBatch(opts);
  const db = opts.db ?? getDb(path.join(opts.repoDir, 'data', 'seen.sqlite'));

  db.transaction((tx) => {
    for (const s of validated.scorings) {
      const row = { id: `${s.week}:${s.candidateId}`, ...s };
      tx.insert(scoringsTable)
        .values(row)
        .onConflictDoUpdate({
          target: scoringsTable.id,
          set: {
            agent: row.agent,
            score: row.score,
            categoria: row.categoria,
            proyectosAfectados: row.proyectosAfectados,
            porQue: row.porQue,
            comoIntegrar: row.comoIntegrar,
            riesgos: row.riesgos,
            usoBrowser: row.usoBrowser,
          },
        })
        .run();
    }
  });
  return validated;
}
