import {
  type EvaluatorAgent,
  collectAntigravity,
  collectBatch,
  prepareBatch,
} from '../batch/index.js';
import { crossWeek } from '../cross/index.js';
import { repoRoot, vaultPath } from '../paths.js';
import { publishWeek } from '../publish/index.js';
import {
  type ApplyOptions,
  applyReview,
  listForReview,
  prepareReview,
} from '../review/index.js';
import { weekStatus } from '../status/index.js';
import { syncInterests as vaultSyncInterests } from '../vault/index.js';
import { collectWeek } from './collect.js';

export * from './candidates-file.js';
export * from './collect.js';
export * from './quota.js';
export * from './week.js';

/** `spf collect`: mitad nube desde la raíz del repo, con el token del entorno. */
export function collect(options: {
  source?: string;
  logger?: (message: string) => void;
}) {
  return collectWeek({
    repoDir: repoRoot(),
    token: process.env.GITHUB_TOKEN,
    // Actions define GITHUB_EVENT_NAME (schedule | workflow_dispatch).
    trigger: process.env.GITHUB_EVENT_NAME ?? 'manual',
    ...options,
  });
}

/**
 * `spf collect --dry-run`: el mismo camino que `collect`, sin escribir nada (ni
 * `data/candidates/`, ni `seen.sqlite`, ni `runs`, ni la caché) y sin enriquecer.
 */
export function collectDryRun(options: {
  source?: string;
  logger?: (message: string) => void;
}) {
  return collectWeek({
    repoDir: repoRoot(),
    token: process.env.GITHUB_TOKEN,
    trigger: 'dry-run',
    ...options,
    dryRun: true,
  });
}

/** `spf prepare --week`: genera `data/batches/<week>/batch.md`. */
export function prepare(week: string) {
  return prepareBatch({ repoDir: repoRoot(), week });
}

/** `spf collect-batch --week`: valida `scoring.json` y guarda los scorings. */
export function collectScorings(week: string, agent?: EvaluatorAgent) {
  return collectBatch({ repoDir: repoRoot(), week, agent });
}

/** `spf collect-batch --agent antigravity`: el segundo evaluador; un fallo se anota en `runs` y no es fatal. */
export function collectAntigravityScorings(week: string, reason?: string) {
  return collectAntigravity({ repoDir: repoRoot(), week, reason });
}

/** `spf cross --week`: cruza las dos evaluaciones y escribe `cruce.json`. */
export function cross(week: string) {
  return crossWeek({ repoDir: repoRoot(), week });
}

/** `spf publish --week`: informe en `Informes/` y filas nuevas en `Catalogo.md`. */
export function publish(week: string, options: { force?: boolean } = {}) {
  return publishWeek({
    repoDir: repoRoot(),
    vaultDir: vaultPath(),
    week,
    ...options,
  });
}

/** `spf review --list`: hallazgos en `candidato` pendientes de revisar. */
export function reviewList() {
  return listForReview({ repoDir: repoRoot(), vaultDir: vaultPath() });
}

/** `spf review --prepare`: clon seguro e inventario de uno o varios hallazgos. */
export function reviewPrepare(options: { ids?: string[]; week?: string }) {
  return prepareReview({
    repoDir: repoRoot(),
    vaultDir: vaultPath(),
    ...options,
  });
}

/** `spf review --apply`: escribe el estado de un hallazgo en Catalogo.md (con la puerta de seguridad). */
export function reviewApply(
  options: Omit<ApplyOptions, 'repoDir' | 'vaultDir'>,
) {
  return applyReview({
    repoDir: repoRoot(),
    vaultDir: vaultPath(),
    ...options,
  });
}

/** `spf status --week`: qué pasos del flujo semanal están hechos. */
export function status(week: string) {
  return weekStatus({ repoDir: repoRoot(), vaultDir: vaultPath(), week });
}

export async function pipelineSyncInterests() {
  return vaultSyncInterests({ vaultDir: vaultPath(), repoDir: repoRoot() });
}
