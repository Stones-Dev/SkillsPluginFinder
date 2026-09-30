import path from 'node:path';
import {
  createBatch as batchCreate,
  processBatchResults,
} from '../batch/index.js';
import { collectFromGithub } from '../collectors/github.js';
import { loadCatalog } from '../config/interests.js';
import { filterCandidates } from '../filter/index.js';
import {
  dedupeCandidates,
  markAsSeen,
  normalizeGithubRepo,
} from '../normalize/index.js';
import { repoRoot, vaultPath } from '../paths.js';
import {
  publishReport as pubReport,
  updateCatalog as pubUpdateCatalog,
} from '../publish/index.js';
import {
  readInterestsFromVault,
  syncInterests as vaultSyncInterests,
} from '../vault/index.js';

export async function runPipeline(
  step: string,
  source?: string,
  logger?: (message: string) => void,
) {
  if (step === 'collect') {
    if (source && source !== 'github-search') {
      throw new Error(`Fuente no soportada: ${source} (solo github-search)`);
    }
    const interests = await readInterestsFromVault(vaultPath());
    const { repos, errors, stats } = await collectFromGithub({
      token: process.env.GITHUB_TOKEN,
      interests,
      cacheDir: path.join(repoRoot(), 'data', 'cache', 'github'),
      logger,
    });
    logger?.(
      `github-search: ${stats.executed}/${stats.queries} consultas (${stats.requests} peticiones, ${stats.cacheHits} de caché), ${stats.rawItems} resultados, ${stats.uniqueRepos} repos únicos, ${errors.length} errores`,
    );
    for (const e of errors) logger?.(`  error: ${e.query ?? ''} ${e.message}`);

    const now = new Date();
    const normalized = repos.map((r) =>
      normalizeGithubRepo(r, { interests, now }),
    );
    const deduped = await dedupeCandidates(normalized);
    const catalog = await loadCatalog(repoRoot());
    return filterCandidates(deduped, interests, catalog, now).kept;
  }
  return [];
}

export async function prepareBatch(week: string) {
  const candidates = await runPipeline('collect');
  if (candidates.length > 0) {
    await batchCreate(candidates, week, repoRoot());
    await markAsSeen(candidates.map((c) => c.id));
  }
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
