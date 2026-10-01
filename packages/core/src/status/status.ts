import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { batchDir, scoringFileName } from '../batch/collect.js';
import { readCruce } from '../cross/cross.js';
import { type Db, getDb } from '../db/index.js';
import { runs, scorings } from '../db/schema.js';
import { readCandidatesFile } from '../pipeline/candidates-file.js';
import { assertWeek } from '../pipeline/week.js';
import { parseCatalog } from '../vault/catalogo.js';

export type StatusStep = {
  /** Nombre corto del paso. */
  name: string;
  done: boolean;
  detail: string;
};

export type WeekStatus = {
  week: string;
  steps: StatusStep[];
  /** La semana está cerrada: ningún paso pendiente. */
  complete: boolean;
  /** No hay recogida de esa semana: no hay nada que evaluar ni que reintentar. */
  nothingToEvaluate: boolean;
};

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/**
 * Estado del flujo semanal de una semana (`spf status`): recogida, evaluación de
 * Claude Code, la de Antigravity (hecha, o fallida y anotada, que cuenta como
 * resuelta: no se reintenta), cruce, publicación posterior al cruce y revisión de
 * los `candidato` de esa semana. El reintento de las 12:00 solo lanza el flujo si
 * la semana no está completa.
 */
export async function weekStatus(opts: {
  repoDir: string;
  vaultDir: string;
  week: string;
  db?: Db;
}): Promise<WeekStatus> {
  const { repoDir, vaultDir } = opts;
  const week = assertWeek(opts.week);
  const db = opts.db ?? getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  const steps: StatusStep[] = [];
  const add = (name: string, done: boolean, detail: string) =>
    steps.push({ name, done, detail });

  const candidates = await readCandidatesFile(repoDir, week);
  add(
    'recogida',
    candidates !== null,
    candidates
      ? `${candidates.candidates.length} fichas en data/candidates/${week}.json`
      : `no existe data/candidates/${week}.json (la recogida no se ha hecho)`,
  );

  const claudeRows = db
    .select()
    .from(scorings)
    .where(and(eq(scorings.week, week), eq(scorings.agent, 'claude-code')))
    .all();
  const claudeFile = await exists(
    path.join(batchDir(repoDir, week), scoringFileName()),
  );
  add(
    'evaluación de Claude Code',
    claudeRows.length > 0,
    claudeRows.length > 0
      ? `${claudeRows.length} scorings validados`
      : claudeFile
        ? 'hay scoring.json pero no se ha validado con collect-batch'
        : 'sin scoring.json',
  );

  const agyRows = db
    .select()
    .from(scorings)
    .where(and(eq(scorings.week, week), eq(scorings.agent, 'antigravity')))
    .all();
  const agyFailures = db
    .select()
    .from(runs)
    .where(and(eq(runs.week, week), eq(runs.trigger, 'antigravity')))
    .all();
  add(
    'evaluación de Antigravity',
    agyRows.length > 0 || agyFailures.length > 0,
    agyRows.length > 0
      ? `${agyRows.length} scorings validados`
      : agyFailures.length > 0
        ? `falló y está anotada (${agyFailures[agyFailures.length - 1].errorsBySource[0]?.message ?? 'sin detalle'}); la semana sigue con Claude Code`
        : 'pendiente',
  );

  const cruce = await readCruce(repoDir, week);
  add(
    'cruce',
    cruce !== null,
    cruce
      ? `cruce.json con ${cruce.fuentes.join(' + ')}`
      : 'sin cruce.json (spf cross)',
  );

  const published = db
    .select()
    .from(runs)
    .where(and(eq(runs.week, week), eq(runs.half, 'evaluate')))
    .all()
    .filter((r) => typeof r.stats.published === 'number');
  const lastPublish = published
    .map((r) => r.startedAt)
    .sort()
    .at(-1);
  const stale =
    cruce !== null &&
    lastPublish !== undefined &&
    lastPublish < cruce.generatedAt;
  add(
    'publicación',
    lastPublish !== undefined && !stale,
    lastPublish === undefined
      ? 'el informe no se ha publicado'
      : stale
        ? 'el informe es anterior al cruce (hay que volver a publicar)'
        : `informe publicado (${published.length} ejecuciones)`,
  );

  const catalog = parseCatalog(
    await fs.readFile(path.join(vaultDir, 'Catalogo.md'), 'utf8'),
  );
  const pending = catalog.filter(
    (e) => e.estado === 'candidato' && e.semana === week,
  );
  add(
    'revisión de hallazgos',
    pending.length === 0 && claudeRows.length > 0 && lastPublish !== undefined,
    pending.length > 0
      ? `${pending.length} en candidato sin revisar: ${pending.map((e) => e.nombre).join(', ')}`
      : lastPublish === undefined
        ? 'aún no hay hallazgos publicados que revisar'
        : 'ningún candidato pendiente',
  );

  return {
    week,
    steps,
    complete: steps.every((s) => s.done),
    nothingToEvaluate: candidates === null,
  };
}

/** Líneas para la terminal. */
export function formatStatus(s: WeekStatus): string[] {
  return [
    `Semana ${s.week}: ${s.complete ? 'cerrada' : 'sin cerrar'}`,
    ...s.steps.map((x) => `  ${x.done ? '✓' : '✗'} ${x.name} — ${x.detail}`),
  ];
}
