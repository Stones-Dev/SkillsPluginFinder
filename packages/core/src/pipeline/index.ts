import { readInterestsFromVault, syncInterests as vaultSyncInterests } from '../vault/index.js';
import { collectFromGithub } from '../collectors/github.js';
import { normalizeCandidate, dedupeCandidates, markAsSeen } from '../normalize/index.js';
import { filterCandidates } from '../filter/index.js';
import { createBatch as batchCreate, processBatchResults } from '../batch/index.js';
import { publishReport as pubReport, updateCatalog as pubUpdateCatalog } from '../publish/index.js';
import path from 'node:path';

// If CWD is apps/worker, vault is at ../../vault.
const DEFAULT_VAULT_PATH = path.resolve(process.cwd(), '../../vault');
const DEFAULT_REPO_PATH = path.resolve(process.cwd(), '../../');

export async function runPipeline(step: string) {
  console.log(`Running pipeline step: ${step}`);
  if (step === 'collect') {
    const interests = await readInterestsFromVault(DEFAULT_VAULT_PATH);
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
    await markAsSeen(candidates.map(c => c.url));
  }
}

export async function collectBatch(week: string) {
  console.log(`Collecting batch results for week ${week}...`);
  const results = await processBatchResults(week, DEFAULT_REPO_PATH);
  return results;
}

export async function pipelinePublishReport(week: string, results: any[]) {
  console.log(`Publishing results for week ${week}...`);
  await pubReport(week, results, DEFAULT_VAULT_PATH);
}

export async function pipelineUpdateCatalog(results: any[]) {
  console.log(`Updating catalog...`);
  await pubUpdateCatalog(results, DEFAULT_VAULT_PATH);
}

export async function pipelineSyncInterests() {
  console.log(`Syncing interests...`);
  await vaultSyncInterests(DEFAULT_VAULT_PATH, DEFAULT_REPO_PATH);
}
