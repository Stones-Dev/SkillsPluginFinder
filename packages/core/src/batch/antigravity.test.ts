import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Scoring } from '../config/schema.js';
import { closeDatabases, getDb } from '../db/index.js';
import { runs, scorings as scoringsTable } from '../db/schema.js';
import type { Candidate } from '../normalize/candidate.js';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import {
  NOW,
  catalog,
  interestsYaml,
  realCandidates,
} from '../testing/real-data.js';
import { collectAntigravity } from './antigravity.js';
import {
  BatchRejectedError,
  collectBatch,
  scoringFileName,
  scoringRowId,
  validateBatch,
} from './collect.js';

const WEEK = '2026-W40';
const candidates: Candidate[] = realCandidates().slice(0, 6);

const score = (
  c: Candidate,
  agent: Scoring['agent'],
  value: number,
): Scoring => ({
  candidateId: c.id,
  week: WEEK,
  agent,
  score: value,
  categoria: 'claude-skills',
  proyectosAfectados: [],
  porQue: 'Razón concreta de por qué encaja o no con los proyectos.',
  comoIntegrar: 'Probarlo en una rama.',
  riesgos: [],
  usoBrowser: false,
});
const scores = (agent: Scoring['agent'], values: number[]) =>
  candidates.map((c, i) => score(c, agent, values[i]));

let repoDir: string;
beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-agy-batch-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), interestsYaml);
  fs.writeFileSync(path.join(repoDir, 'catalog.json'), JSON.stringify(catalog));
  await writeCandidatesFile(repoDir, {
    week: WEEK,
    generatedAt: NOW.toISOString(),
    runs: [],
    candidates,
    descartados: [],
    diferidos: [],
  });
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const write = (file: string, raw: unknown) => {
  const dir = path.join(repoDir, 'data', 'batches', WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(raw));
};
const db = () => getDb(path.join(repoDir, 'data', 'seen.sqlite'));

test('cada agente tiene su fichero y su id de fila, y el de Claude Code no cambia', () => {
  expect(scoringFileName()).toBe('scoring.json');
  expect(scoringFileName('claude-code')).toBe('scoring.json');
  expect(scoringFileName('antigravity')).toBe('scoring-antigravity.json');
  const base = { week: WEEK, candidateId: 'github:a/b' };
  expect(scoringRowId({ ...base, agent: 'claude-code' })).toBe(
    '2026-W40:github:a/b',
  );
  expect(scoringRowId({ ...base, agent: 'antigravity' })).toBe(
    '2026-W40:github:a/b:antigravity',
  );
});

test('los dos evaluadores se guardan sin pisarse en scorings', async () => {
  write('scoring.json', scores('claude-code', [9, 8, 7, 5, 4, 3]));
  write('scoring-antigravity.json', scores('antigravity', [9, 4, 7, 6, 4, 2]));

  await collectBatch({ repoDir, week: WEEK });
  const r = await collectAntigravity({ repoDir, week: WEEK });

  expect(r.ok).toBe(true);
  const rows = await db().select().from(scoringsTable);
  expect(rows).toHaveLength(12);
  const cc = rows.filter((x) => x.agent === 'claude-code');
  const ag = rows.filter((x) => x.agent === 'antigravity');
  expect(cc.map((x) => x.id)).toEqual(candidates.map((c) => `${WEEK}:${c.id}`));
  expect(ag.map((x) => x.id)).toEqual(
    candidates.map((c) => `${WEEK}:${c.id}:antigravity`),
  );
  expect(ag.map((x) => x.score)).toEqual([9, 4, 7, 6, 4, 2]);
  expect(cc.map((x) => x.score)).toEqual([9, 8, 7, 5, 4, 3]);
});

test('repetir collect-batch --agent antigravity actualiza, no duplica', async () => {
  write('scoring-antigravity.json', scores('antigravity', [9, 8, 7, 5, 4, 3]));
  await collectAntigravity({ repoDir, week: WEEK });
  write('scoring-antigravity.json', scores('antigravity', [6, 6, 6, 6, 6, 6]));

  await collectAntigravity({ repoDir, week: WEEK });

  const rows = await db().select().from(scoringsTable);
  expect(rows).toHaveLength(6);
  expect(rows.every((x) => x.score === 6)).toBe(true);
});

test('un fichero de Antigravity con filas de otro agente se rechaza con el motivo', async () => {
  write('scoring-antigravity.json', scores('claude-code', [5, 5, 5, 5, 5, 5]));

  await expect(
    validateBatch({ repoDir, week: WEEK, agent: 'antigravity' }),
  ).rejects.toSatisfy(
    (e) =>
      e instanceof BatchRejectedError &&
      e.problems.length === 6 &&
      e.problems[0].includes('agent "claude-code" no es "antigravity"'),
  );
});

test('el scoring.json de Claude Code sigue sin exigir agente (compatibilidad)', async () => {
  write('scoring.json', scores('antigravity', [5, 5, 5, 5, 5, 5]));

  await expect(validateBatch({ repoDir, week: WEEK })).resolves.toBeDefined();
});

test('sin scoring-antigravity.json: no es fatal, se anota en runs y se sigue con Claude Code', async () => {
  write('scoring.json', scores('claude-code', [9, 8, 7, 5, 4, 3]));

  const r = await collectAntigravity({ repoDir, week: WEEK });

  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain('scoring-antigravity.json');
  const rows = await db().select().from(runs);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    half: 'evaluate',
    week: WEEK,
    trigger: 'antigravity',
    stats: { scored: 0, antigravity: 0 },
  });
  expect(rows[0].errorsBySource).toEqual([
    { source: 'antigravity', message: expect.stringContaining('No existe') },
  ]);
  expect(await db().select().from(scoringsTable)).toHaveLength(0);
});

test('un fichero que no valida se anota con todos los problemas y no guarda nada', async () => {
  write('scoring-antigravity.json', [
    ...scores('antigravity', [5, 5, 5, 5, 5]),
    { candidateId: 'github:no/existe' },
  ]);

  const r = await collectAntigravity({ repoDir, week: WEEK });

  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain('rechazado');
  expect(await db().select().from(scoringsTable)).toHaveLength(0);
  expect((await db().select().from(runs))[0].errorsBySource[0].source).toBe(
    'antigravity',
  );
});

test('--reason deja en runs por qué falló el wrapper, aunque haya un fichero válido', async () => {
  write('scoring-antigravity.json', scores('antigravity', [5, 5, 5, 5, 5, 5]));

  const r = await collectAntigravity({
    repoDir,
    week: WEEK,
    reason: 'agy agotó el tiempo (código 3)',
  });

  expect(r).toEqual({ ok: false, error: 'agy agotó el tiempo (código 3)' });
  expect((await db().select().from(runs))[0].errorsBySource).toEqual([
    { source: 'antigravity', message: 'agy agotó el tiempo (código 3)' },
  ]);
  expect(await db().select().from(scoringsTable)).toHaveLength(0);
});

test('un JSON roto de Antigravity también es un fallo no fatal', async () => {
  const dir = path.join(repoDir, 'data', 'batches', WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scoring-antigravity.json'), '[{ roto');

  const r = await collectAntigravity({ repoDir, week: WEEK });

  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain(
    'scoring-antigravity.json no es JSON válido',
  );
});
