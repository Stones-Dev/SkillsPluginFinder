import { collectBatch, prepareBatch } from '../batch/index.js';
import { repoRoot, vaultPath } from '../paths.js';
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

/** `spf prepare --week`: genera `data/batches/<week>/batch.md`. */
export function prepare(week: string) {
  return prepareBatch({ repoDir: repoRoot(), week });
}

/** `spf collect-batch --week`: valida `scoring.json` y guarda los scorings. */
export function collectScorings(week: string) {
  return collectBatch({ repoDir: repoRoot(), week });
}

export async function pipelineSyncInterests() {
  return vaultSyncInterests({ vaultDir: vaultPath(), repoDir: repoRoot() });
}
