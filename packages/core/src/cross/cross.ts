import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { batchDir, validateBatch } from '../batch/collect.js';
import type { Scoring } from '../config/schema.js';
import { readCandidatesFile } from '../pipeline/candidates-file.js';
import { assertWeek } from '../pipeline/week.js';
import { atomicWriteFile } from '../vault/fsutil.js';

/** Desacuerdo (en puntos) a partir del cual los dos evaluadores están en «disputa». */
export const DISPUTA_DELTA = 3;
/** Score que tienen que alcanzar los dos para hablar de «confianza alta». */
export const CONFIANZA_ALTA_MIN = 7;

/** Marcas que `spf cross` y `spf publish` dejan al principio de la nota de la fila del catálogo. */
export const DISPUTA_MARK = '⚖ disputa';
export const CONFIANZA_MARK = '✓ confianza alta';

export const cruceItemSchema = z
  .object({
    candidateId: z.string().min(1),
    claude: z.number().int().min(1).max(10),
    /** `null` si Antigravity no evaluó (fichero ausente o inválido). */
    antigravity: z.number().int().min(1).max(10).nullable(),
    /** Media de los dos, con un decimal; o el score de Claude Code si es el único. */
    final: z.number().min(1).max(10),
    disputa: z.boolean(),
    confianzaAlta: z.boolean(),
  })
  .strict();

export type CruceItem = z.infer<typeof cruceItemSchema>;

export const cruceSchema = z
  .object({
    version: z.literal(1),
    week: z.string().regex(/^\d{4}-W\d{2}$/),
    generatedAt: z.string(),
    fuentes: z.array(z.enum(['claude-code', 'antigravity'])).min(1),
    umbral: z.number(),
    items: z.array(cruceItemSchema),
  })
  .strict();

export type Cruce = z.infer<typeof cruceSchema>;

export const cruceFile = (repoDir: string, week: string) =>
  path.join(batchDir(repoDir, week), 'cruce.json');

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Cruza las dos evaluaciones (Plan §7 bis): media de los scores, `disputa` si
 * difieren en 3 o más y `confianzaAlta` si los dos llegan a 7. Sin Antigravity
 * (`null`) se usa solo la de Claude Code y no hay disputa ni confianza.
 */
export function crossScorings(
  claude: Scoring[],
  antigravity: Scoring[] | null,
): CruceItem[] {
  const ag = new Map((antigravity ?? []).map((s) => [s.candidateId, s.score]));
  return claude.map((c) => {
    const a = ag.get(c.candidateId) ?? null;
    if (a === null) {
      return {
        candidateId: c.candidateId,
        claude: c.score,
        antigravity: null,
        final: c.score,
        disputa: false,
        confianzaAlta: false,
      };
    }
    return {
      candidateId: c.candidateId,
      claude: c.score,
      antigravity: a,
      final: round1((c.score + a) / 2),
      disputa: Math.abs(c.score - a) >= DISPUTA_DELTA,
      confianzaAlta: c.score >= CONFIANZA_ALTA_MIN && a >= CONFIANZA_ALTA_MIN,
    };
  });
}

export type CruceSummary = {
  total: number;
  /** Con las dos evaluaciones. */
  cruzadas: number;
  iguales: number;
  /** Difieren en 1 o 2 puntos. */
  cercanas: number;
  disputas: CruceItem[];
  confianzaAlta: CruceItem[];
  /** Filas cuyo score cambia o que entran o salen de lo publicable (≥ umbral). */
  cambiaInforme: CruceItem[];
};

export function summarizeCruce(
  items: CruceItem[],
  umbral: number,
): CruceSummary {
  const both = items.filter((i) => i.antigravity !== null);
  return {
    total: items.length,
    cruzadas: both.length,
    iguales: both.filter((i) => i.claude === i.antigravity).length,
    cercanas: both.filter(
      (i) => i.antigravity !== null && i.claude !== i.antigravity && !i.disputa,
    ).length,
    disputas: items.filter((i) => i.disputa),
    confianzaAlta: items.filter((i) => i.confianzaAlta),
    // Lo que se ve en el informe: scores ≥ umbral que cambian o filas que cruzan el umbral.
    cambiaInforme: items.filter(
      (i) => (i.claude >= umbral || i.final >= umbral) && i.final !== i.claude,
    ),
  };
}

/** Prefijo de la nota del catálogo: `⚖ disputa CC 8 · AG 4 — `, `✓ confianza alta CC 8 · AG 8 — ` o nada. */
export function markFor(item: CruceItem | undefined): string {
  if (!item || item.antigravity === null) return '';
  const scores = `CC ${item.claude} · AG ${item.antigravity}`;
  if (item.disputa) return `${DISPUTA_MARK} ${scores} — `;
  if (item.confianzaAlta) return `${CONFIANZA_MARK} ${scores} — `;
  return '';
}

const MARKS = new RegExp(
  `^(?:(?:${DISPUTA_MARK}|${CONFIANZA_MARK}) CC \\d+ · AG \\d+ — )+`,
);

/** Quita las marcas de cruce del principio de una nota (para volver a ponerlas sin duplicarlas). */
export const stripMarks = (nota: string) => nota.replace(MARKS, '');

/** Las marcas de cruce con las que empieza una nota, o `''`. */
export const leadingMarks = (nota: string) => nota.match(MARKS)?.[0] ?? '';

/** Línea del informe con las dos evaluaciones, o `null` si solo hay una. */
export function crossLine(item: CruceItem | undefined): string | null {
  if (!item || item.antigravity === null) return null;
  const marks = [
    item.disputa ? `${DISPUTA_MARK}` : '',
    item.confianzaAlta ? CONFIANZA_MARK : '',
  ].filter(Boolean);
  return `**Evaluación cruzada:** Claude Code ${item.claude} · Antigravity ${item.antigravity} → ${item.final}${marks.length > 0 ? ` · ${marks.join(' · ')}` : ''}`;
}

export async function readCruce(
  repoDir: string,
  week: string,
): Promise<Cruce | null> {
  let text: string;
  try {
    text = await fs.readFile(cruceFile(repoDir, week), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = cruceSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${cruceFile(repoDir, week)} no cumple el esquema: vuelve a ejecutar spf cross --week ${week}.`,
    );
  }
  return parsed.data;
}

/**
 * Los scorings de Claude Code con el score final del cruce. Si `cruce.json` no
 * corresponde a esos scorings (se reevaluó después de cruzar), falla en vez de
 * publicar números viejos.
 */
export function applyCruce(scorings: Scoring[], cruce: Cruce): Scoring[] {
  const byId = new Map(cruce.items.map((i) => [i.candidateId, i]));
  return scorings.map((s) => {
    const item = byId.get(s.candidateId);
    if (!item || item.claude !== s.score) {
      throw new Error(
        `cruce.json está desfasado (${s.candidateId} ya no coincide con scoring.json): vuelve a ejecutar spf cross --week ${cruce.week}.`,
      );
    }
    return { ...s, score: item.final };
  });
}

export type CrossResult = {
  cruce: Cruce;
  file: string;
  summary: CruceSummary;
  /** Por qué no se cruzó con Antigravity, si no se pudo. */
  antigravityError?: string;
  /** Nombre de cada candidato, para imprimir. */
  names: Map<string, string>;
};

/**
 * `spf cross`: valida las dos evaluaciones con el esquema de siempre y escribe
 * `data/batches/<semana>/cruce.json`. Si la de Antigravity falta o no valida,
 * sigue solo con la de Claude Code y lo dice (Plan §7 bis).
 */
export async function crossWeek(opts: {
  repoDir: string;
  week: string;
  now?: Date;
}): Promise<CrossResult> {
  const { repoDir } = opts;
  const week = assertWeek(opts.week);

  const claude = await validateBatch({ repoDir, week });
  let antigravity: Awaited<ReturnType<typeof validateBatch>> | null = null;
  let antigravityError: string | undefined;
  try {
    antigravity = await validateBatch({ repoDir, week, agent: 'antigravity' });
  } catch (err) {
    antigravityError = (err as Error).message.replace(/\s+/g, ' ').trim();
  }

  const umbral = claude.interests.umbral_score;
  const items = crossScorings(claude.scorings, antigravity?.scorings ?? null);
  const cruce: Cruce = {
    version: 1,
    week,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    fuentes: antigravity ? ['claude-code', 'antigravity'] : ['claude-code'],
    umbral,
    items,
  };
  const file = cruceFile(repoDir, week);
  await atomicWriteFile(
    file,
    `${JSON.stringify(cruceSchema.parse(cruce), null, 2)}\n`,
  );

  const candidates =
    (await readCandidatesFile(repoDir, week))?.candidates ?? [];
  return {
    cruce,
    file,
    summary: summarizeCruce(items, umbral),
    antigravityError,
    names: new Map(candidates.map((c) => [c.id, c.name])),
  };
}

const pad = (n: number, width = 2) => String(n).padStart(width);

/** Resumen para la terminal: coincidencias, desacuerdos y si cambia el informe. */
export function formatCross(r: CrossResult): string[] {
  const { cruce, summary: s, names } = r;
  const name = (id: string) => names.get(id) ?? id;
  const lines: string[] = [];

  if (cruce.fuentes.length === 1) {
    lines.push(
      `Cruce ${cruce.week}: solo Claude Code (${s.total} fichas)`,
      `  Antigravity no aporta evaluación: ${r.antigravityError ?? 'no hay scoring-antigravity.json'}`,
      '  publicación: sin cambios (el cruce es la evaluación de Claude Code)',
    );
    return [...lines, `→ ${r.file}`];
  }

  lines.push(
    `Cruce ${cruce.week}: Claude Code + Antigravity (${s.total} fichas)`,
    `  coinciden en el score: ${pad(s.iguales)} · difieren 1-2 puntos: ${pad(s.cercanas)} · desacuerdo ≥ ${DISPUTA_DELTA}: ${pad(s.disputas.length)}`,
    `  confianza alta (los dos ≥ ${CONFIANZA_ALTA_MIN}): ${s.confianzaAlta.length}`,
  );
  if (s.disputas.length > 0) {
    lines.push('  disputas:');
    for (const d of s.disputas) {
      lines.push(
        `    ${name(d.candidateId)} — CC ${d.claude} · AG ${d.antigravity} → ${d.final}`,
      );
    }
  }
  if (s.confianzaAlta.length > 0) {
    lines.push('  confianza alta:');
    for (const d of s.confianzaAlta) {
      lines.push(
        `    ${name(d.candidateId)} — CC ${d.claude} · AG ${d.antigravity} → ${d.final}`,
      );
    }
  }
  if (s.cambiaInforme.length > 0) {
    lines.push(
      `  publicación: cambia (${s.cambiaInforme.length} fila${s.cambiaInforme.length === 1 ? '' : 's'} con score ≥ ${cruce.umbral} distinto o que cruza el umbral)`,
    );
    for (const d of s.cambiaInforme) {
      lines.push(
        `    ${name(d.candidateId)} — CC ${d.claude} → ${d.final}${d.antigravity !== null ? ` (AG ${d.antigravity})` : ''}`,
      );
    }
  } else {
    lines.push('  publicación: sin cambios');
  }
  return [...lines, `→ ${r.file}`];
}
