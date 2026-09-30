import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import {
  NOW,
  catalog,
  cloddsBot,
  interestsYaml,
  realCandidates,
} from '../testing/real-data.js';
import { prepareBatch } from './prepare.js';

let repoDir: string;
const batchFile = (name: string) =>
  path.join(repoDir, 'data', 'batches', '2026-W40', name);

const stats = {
  queries: 1,
  requests: 1,
  cacheHits: 0,
  rawItems: 30,
  uniqueRepos: 30,
  afterDedupe: 30,
  afterRules: 3,
  selected: 3,
  deferred: 0,
  enriched: 3,
};

async function seedCandidates() {
  await writeCandidatesFile(repoDir, {
    week: '2026-W40',
    generatedAt: NOW.toISOString(),
    runs: [
      { at: NOW.toISOString(), trigger: 'manual', stats, errorsBySource: [] },
    ],
    candidates: [...realCandidates().slice(0, 2), cloddsBot()],
    descartados: [],
    diferidos: [],
  });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-prepare-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), interestsYaml);
  fs.writeFileSync(path.join(repoDir, 'catalog.json'), JSON.stringify(catalog));
});
afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('genera batch.md desde el fichero de candidatos y los espejos, sin red', async () => {
  await seedCandidates();
  const result = await prepareBatch({ repoDir, week: '2026-W40' });

  expect(result.file).toBe(batchFile('batch.md'));
  expect(result.candidates).toBe(3);
  expect(result.categories).toEqual({ 'claude-skills': 2, solana: 1 });
  expect(result.scoringExists).toBe(false);

  const md = fs.readFileSync(result.file, 'utf8');
  expect(md).toContain('# Batch 2026-W40 — evaluación semanal');
  expect(md).toContain('3 fichas');
  expect(md).toContain('- **id:** `github:alsk1992/cloddsbot`');
  expect(fs.readdirSync(path.dirname(result.file))).toEqual(['batch.md']);
});

test('regenerar el batch no toca un scoring.json existente', async () => {
  await seedCandidates();
  await prepareBatch({ repoDir, week: '2026-W40' });
  fs.writeFileSync(batchFile('scoring.json'), '[{"trabajo":"del evaluador"}]');

  const again = await prepareBatch({ repoDir, week: '2026-W40' });

  expect(again.scoringExists).toBe(true);
  expect(fs.readFileSync(batchFile('scoring.json'), 'utf8')).toBe(
    '[{"trabajo":"del evaluador"}]',
  );
});

test('una semana sin candidatos produce un batch vacío válido, no un error', async () => {
  await writeCandidatesFile(repoDir, {
    week: '2026-W40',
    generatedAt: NOW.toISOString(),
    runs: [],
    candidates: [],
    descartados: [],
    diferidos: [],
  });
  const result = await prepareBatch({ repoDir, week: '2026-W40' });

  expect(result.candidates).toBe(0);
  expect(fs.readFileSync(result.file, 'utf8')).toContain(
    'escribe `[]` en `scoring.json`',
  );
});

test('sin fichero de candidatos manda ejecutar collect y no escribe nada', async () => {
  await expect(prepareBatch({ repoDir, week: '2026-W40' })).rejects.toThrow(
    'pnpm spf collect',
  );
  expect(fs.existsSync(path.join(repoDir, 'data', 'batches'))).toBe(false);
});

test('sin los espejos del repo manda ejecutar interests sync', async () => {
  await seedCandidates();
  fs.rmSync(path.join(repoDir, 'catalog.json'));

  await expect(prepareBatch({ repoDir, week: '2026-W40' })).rejects.toThrow(
    'interests sync',
  );
});

test('rechaza una semana con formato inválido antes de tocar el disco', async () => {
  await expect(prepareBatch({ repoDir, week: '../x' })).rejects.toThrow(
    'Semana inválida',
  );
});
