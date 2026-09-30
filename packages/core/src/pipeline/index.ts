import {
  createBatch as batchCreate,
  processBatchResults,
} from '../batch/index.js';
import { repoRoot, vaultPath } from '../paths.js';
import {
  publishReport as pubReport,
  updateCatalog as pubUpdateCatalog,
} from '../publish/index.js';
import { syncInterests as vaultSyncInterests } from '../vault/index.js';
import { readCandidatesFile } from './candidates-file.js';
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

export async function prepareBatch(week: string) {
  const file = await readCandidatesFile(repoRoot(), week);
  if (!file) {
    throw new Error(
      `No existe data/candidates/${week}.json: ejecuta "pnpm spf collect" antes de preparar el batch.`,
    );
  }
  return batchCreate(file.candidates, week, repoRoot());
}

export async function collectBatch(week: string) {
  return processBatchResults(week, repoRoot());
}

export async function pipelinePublishReport(week: string, results: any[]) {
  await pubReport(week, results, vaultPath());
}

export async function pipelineUpdateCatalog(results: any[]) {
  await pubUpdateCatalog(results, vaultPath());
}

export async function pipelineSyncInterests() {
  return vaultSyncInterests({ vaultDir: vaultPath(), repoDir: repoRoot() });
}
