import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import { type Candidate, normalizeGithubRepo } from '../normalize/index.js';
import { extractYamlBlock } from '../vault/markdown.js';
import {
  type CandidatesFile,
  type RunRecord,
  candidatesPath,
  mergeCandidatesFile,
  readCandidatesFile,
  writeCandidatesFile,
} from './candidates-file.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const read = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8').replace(/\r\n/g, '\n');
const items = JSON.parse(read('github-search/response.json'))
  .items as GithubRepo[];
const interests = parseInterestsYaml(
  extractYamlBlock(read('vault/Intereses.md')).body,
  'Intereses.md',
);
const NOW = new Date('2026-09-30T12:00:00Z');

const candidate = (index: number): Candidate =>
  normalizeGithubRepo(
    {
      repo: items[index],
      origins: [{ categoria: 'claude-skills', tipo: 'keyword', query: 'x' }],
    },
    { interests, now: NOW },
  );
const [A, B, C, D, F] = [1, 2, 3, 5, 6].map(candidate);

const stats = (over: Partial<RunRecord['stats']> = {}): RunRecord['stats'] => ({
  queries: 1,
  requests: 1,
  cacheHits: 0,
  rawItems: 30,
  uniqueRepos: 30,
  afterDedupe: 30,
  afterRules: 20,
  selected: 5,
  deferred: 15,
  enriched: 5,
  ...over,
});
const run = (at: string): RunRecord => ({
  at,
  trigger: 'manual',
  stats: stats(),
  errorsBySource: [],
});
const discarded = (c: Candidate) => ({
  id: c.id,
  name: c.name,
  url: c.url,
  regla: 'licencia' as const,
  motivo: 'licencia: ninguna',
});
const deferred = (c: Candidate) => ({
  id: c.id,
  name: c.name,
  url: c.url,
  categoria: 'claude-skills',
  stars: c.stars,
  motivo: 'tope enrich_max=5: cuota de claude-skills = 5 de 20',
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-cand-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const file = (over: Partial<CandidatesFile> = {}): CandidatesFile => ({
  week: '2026-W40',
  generatedAt: NOW.toISOString(),
  runs: [run('2026-09-28T05:00:00.000Z')],
  candidates: [A, B],
  descartados: [discarded(D)],
  diferidos: [deferred(C)],
  ...over,
});

test('escribe y lee data/candidates/YYYY-Www.json sin perder nada', async () => {
  const written = await writeCandidatesFile(tmp, file());

  expect(written).toBe(candidatesPath(tmp, '2026-W40'));
  expect(fs.readdirSync(path.dirname(written))).toEqual(['2026-W40.json']);
  expect(await readCandidatesFile(tmp, '2026-W40')).toEqual(file());
});

test('leer una semana sin fichero devuelve null; un fichero roto falla con el motivo', async () => {
  expect(await readCandidatesFile(tmp, '2026-W41')).toBeNull();

  const target = candidatesPath(tmp, '2026-W40');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{no es json');
  await expect(readCandidatesFile(tmp, '2026-W40')).rejects.toThrow(
    'no es JSON válido',
  );

  fs.writeFileSync(
    target,
    JSON.stringify({ ...file(), candidates: [{ id: 'x' }] }),
  );
  await expect(readCandidatesFile(tmp, '2026-W40')).rejects.toThrow(
    'no cumple el esquema',
  );
});

test('una semana con formato inválido no llega a tocar el disco', async () => {
  await expect(readCandidatesFile(tmp, '../secreto')).rejects.toThrow(
    'Semana inválida',
  );
  expect(() => candidatesPath(tmp, '2026-40')).toThrow('Semana inválida');
});

test('merge sin fichero previo devuelve la recogida tal cual', () => {
  const merged = mergeCandidatesFile(null, {
    week: '2026-W40',
    generatedAt: NOW.toISOString(),
    run: run('2026-09-28T05:00:00.000Z'),
    candidates: [A],
    descartados: [discarded(D)],
    diferidos: [deferred(C)],
  });

  expect(merged.candidates).toEqual([A]);
  expect(merged.descartados.map((d) => d.id)).toEqual([D.id]);
  expect(merged.diferidos.map((d) => d.id)).toEqual([C.id]);
  expect(merged.runs).toHaveLength(1);
});

test('merge con la misma semana: acumula, los recientes ganan y un diferido que entra deja de serlo', () => {
  const later = '2026-09-30T08:00:00.000Z';
  const refreshedA: Candidate = { ...A, stars: A.stars + 100 };
  const merged = mergeCandidatesFile(file(), {
    week: '2026-W40',
    generatedAt: later,
    run: { ...run(later), trigger: 'workflow_dispatch' },
    // C estaba diferido y ahora entra; A vuelve con datos nuevos; F es nuevo
    candidates: [C, refreshedA, F],
    // D sigue descartado; el descartado B... no cambia
    descartados: [discarded(D)],
    diferidos: [deferred(F), deferred(D)],
  });

  expect(merged.generatedAt).toBe(later);
  expect(merged.candidates.map((c) => c.id)).toEqual([A.id, B.id, C.id, F.id]);
  expect(merged.candidates.find((c) => c.id === A.id)?.stars).toBe(
    A.stars + 100,
  );
  // C ya es candidato: no figura como diferido; F también entró
  expect(merged.diferidos.map((d) => d.id)).toEqual([D.id]);
  expect(merged.descartados.map((d) => d.id)).toEqual([D.id]);
  expect(merged.runs.map((r) => r.trigger)).toEqual([
    'manual',
    'workflow_dispatch',
  ]);
});

test('un descartado por reglas que esta semana pasa las reglas deja de figurar como descartado', () => {
  const merged = mergeCandidatesFile(file({ candidates: [A] }), {
    week: '2026-W40',
    generatedAt: NOW.toISOString(),
    run: run(NOW.toISOString()),
    candidates: [D],
    descartados: [],
    diferidos: [],
  });

  expect(merged.candidates.map((c) => c.id)).toEqual([A.id, D.id]);
  expect(merged.descartados).toEqual([]);
});
