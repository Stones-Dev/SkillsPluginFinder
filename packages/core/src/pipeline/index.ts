import {
  createBatch as batchCreate,
  processBatchResults,
} from '../batch/index.js';
import { collectFromGithub } from '../collectors/github.js';
import { filterCandidates } from '../filter/index.js';
import {
  dedupeCandidates,
  markAsSeen,
  normalizeCandidate,
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

export async function runPipeline(step: string, source?: string) {
  if (step === 'collect') {
    if (source && source !== 'github-search') {
      throw new Error(`Fuente no soportada: ${source} (solo github-search)`);
    }
    const interests = await readInterestsFromVault(vaultPath());
    const token = process.env.GITHUB_TOKEN || '';
    const raw = await collectFromGithub(
      token,
      Object.values(interests.categorias || {}).flatMap(
        (c) => c.keywords || [],
      ),
    );

    const normalized = raw.map(normalizeCandidate);
    const deduped = await dedupeCandidates(normalized);
    return filterCandidates(deduped, interests);
  }
  return [];
}

export async function prepareBatch(week: string) {
  const candidates = await runPipeline('collect');
  if (candidates.length > 0) {
    await batchCreate(candidates, week, repoRoot());
    await markAsSeen(candidates.map((c) => c.url));
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
  await vaultSyncInterests(vaultPath(), repoRoot());
}
