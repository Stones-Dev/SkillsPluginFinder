import path from 'node:path';
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
import {
  publishReport as pubReport,
  updateCatalog as pubUpdateCatalog,
} from '../publish/index.js';
import {
  readInterestsFromVault,
  syncInterests as vaultSyncInterests,
} from '../vault/index.js';

// If CWD is apps/worker, vault is at ../../vault.
function getVaultPath() {
  const p = process.env.VAULT_PATH;
  if (!p) throw new Error('VAULT_PATH environment variable is required');
  return p;
}
const DEFAULT_REPO_PATH = path.resolve(process.cwd(), '../../');

export async function runPipeline(step: string) {
  console.log(`Running pipeline step: ${step}`);
  if (step === 'collect') {
    const interests = await readInterestsFromVault(getVaultPath());
    const token = process.env.GITHUB_TOKEN || '';
    const raw = await collectFromGithub(token, interests.keywords || []);

    const normalized = raw.map(normalizeCandidate);
    const deduped = await dedupeCandidates(normalized);
    const filtered = filterCandidates(deduped, interests);

    console.log(`Collected ${filtered.length} candidates after filtering.`);
    return filtered;
  }
  return [];
}

export async function prepareBatch(week: string) {
  console.log(`Preparing batch for week: ${week}`);
  const candidates = await runPipeline('collect');
  if (candidates.length > 0) {
    await batchCreate(candidates, week, DEFAULT_REPO_PATH);
    await markAsSeen(candidates.map((c) => c.url));
  }
}

export async function collectBatch(week: string) {
  console.log(`Collecting batch results for week ${week}...`);
  const results = await processBatchResults(week, DEFAULT_REPO_PATH);
  return results;
}

export async function pipelinePublishReport(week: string, results: any[]) {
  console.log(`Publishing results for week ${week}...`);
  await pubReport(week, results, getVaultPath());
}

export async function pipelineUpdateCatalog(results: any[]) {
  console.log('Updating catalog...');
  await pubUpdateCatalog(results, getVaultPath());
}

export async function pipelineSyncInterests() {
  console.log('Syncing interests...');
  await vaultSyncInterests(getVaultPath(), DEFAULT_REPO_PATH);
}
