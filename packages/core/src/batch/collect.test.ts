import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Scoring } from '../config/schema.js';
import { closeDatabases, getDb } from '../db/index.js';
import { scorings as scoringsTable } from '../db/schema.js';
import type { Candidate } from '../normalize/candidate.js';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import {
  NOW,
  catalog,
  interests,
  interestsYaml,
  realCandidates,
} from '../testing/real-data.js';
import {
  BatchRejectedError,
  checkScoring,
  collectBatch,
  validateBatch,
} from './collect.js';

const WEEK = '2026-W40';
const candidates: Candidate[] = realCandidates().slice(0, 6);

const score = (c: Candidate, over: Partial<Scoring> = {}): Scoring => ({
  candidateId: c.id,
  week: WEEK,
  agent: 'claude-code',
  score: 5,
  categoria: 'claude-skills',
  proyectosAfectados: [],
  porQue: 'Razón concreta de por qué encaja o no con los proyectos.',
  comoIntegrar: 'Probarlo en una rama.',
  riesgos: [],
  usoBrowser: false,
  ...over,
});
const valid = (scores: number[]) =>
  candidates.map((c, i) => score(c, { score: scores[i] }));
const check = (raw: unknown) =>
  checkScoring(raw, { week: WEEK, candidates, interests });

let repoDir: string;
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-batch-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), interestsYaml);
  fs.writeFileSync(path.join(repoDir, 'catalog.json'), JSON.stringify(catalog));
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const seed = async (list: Candidate[] = candidates) =>
  writeCandidatesFile(repoDir, {
    week: WEEK,
    generatedAt: NOW.toISOString(),
    runs: [],
    candidates: list,
    descartados: [],
    diferidos: [],
  });
const writeScoring = (raw: unknown) => {
  const dir = path.join(repoDir, 'data', 'batches', WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scoring.json'),
    typeof raw === 'string' ? raw : JSON.stringify(raw),
  );
};
const db = () => getDb(path.join(repoDir, 'data', 'seen.sqlite'));

test('un batch completo y coherente es válido y se resume por score', () => {
  const { scorings, problems, summary } = check(valid([3, 5, 7, 7, 8, 4]));

  expect(problems).toEqual([]);
  expect(scorings).toHaveLength(6);
  expect(summary).toMatchObject({
    total: 6,
    umbral: 7,
    aboveThreshold: 3,
    high: 1,
  });
  expect(summary.distribution).toEqual({
    1: 0,
    2: 0,
    3: 1,
    4: 1,
    5: 1,
    6: 0,
    7: 2,
    8: 1,
    9: 0,
    10: 0,
  });
});

test('lista todos los problemas a la vez para corregirlos en una sola pasada', () => {
  const [a, b, c, d] = candidates;
  const raw = [
    score(a, { week: '2026-W39' }), // semana equivocada
    score(b, { categoria: 'inventada' }), // categoría inexistente
    score(c, {
      proyectosAfectados: ['SonarTrench — bot de alertas memecoins Solana'],
    }), // línea entera, no el nombre
    score(d),
    score(d), // duplicado
    { ...score(a), candidateId: 'github:nadie/nada' }, // id desconocido
    { ...score(b), score: 11, porQue: '' }, // esquema roto
  ];
  const { problems } = check(raw);

  expect(problems).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`[0] ${a.id}: week "2026-W39" no es "2026-W40"`),
      expect.stringContaining(
        `[1] ${b.id}: categoria "inventada" no existe (válidas: claude-skills,`,
      ),
      expect.stringContaining(
        `[2] ${c.id}: proyecto "SonarTrench — bot de alertas memecoins Solana" no está en <proyectos>; usa solo el nombre`,
      ),
      expect.stringContaining(`[4] ${d.id}: id duplicado`),
      expect.stringContaining(
        '[5] github:nadie/nada: no es el id de ninguna ficha de este batch',
      ),
      expect.stringMatching(/^\[6\] .*score:.*porQue:/),
      expect.stringMatching(/^Faltan 2 de 6 fichas: .*/),
    ]),
  );
  expect(problems.find((p) => p.startsWith('Faltan'))).toContain(
    candidates[4].name,
  );
});

test('los proyectos se validan por nombre (lo que va antes del " — ")', () => {
  const ok = check(
    valid([5, 5, 5, 5, 5, 5]).map((s) => ({
      ...s,
      proyectosAfectados: ['SonarTrench', 'Sage 200 MCP'],
    })),
  );
  expect(ok.problems).toEqual([]);

  const bad = check(
    valid([5, 5, 5, 5, 5, 5]).map((s, i) =>
      i === 0 ? { ...s, proyectosAfectados: ['sonartrench'] } : s,
    ),
  );
  expect(bad.problems).toHaveLength(1);
  expect(bad.problems[0]).toContain(
    'proyecto "sonartrench" no está en <proyectos>',
  );
});

test('cobertura: cada ficha del batch necesita su scoring', () => {
  const { problems } = check(valid([5, 5, 5, 5, 5, 5]).slice(0, 4));
  expect(problems).toEqual([
    `Faltan 2 de 6 fichas: ${candidates[4].name}, ${candidates[5].name}`,
  ]);
});

test('sesgo: más de la mitad de scores ≥ 8 se rechaza; exactamente la mitad se acepta', () => {
  const biased = check(valid([9, 8, 8, 8, 3, 4]));
  expect(biased.problems).toHaveLength(1);
  expect(biased.problems[0]).toMatch(
    /^Sesgo: 4 de 6 fichas \(67 %\) puntúan 8 o más/,
  );

  expect(check(valid([9, 8, 8, 3, 4, 5])).problems).toEqual([]); // 3 de 6 = 50 %
});

test('el sesgo se aplica literal también con muy pocas fichas', () => {
  const one = checkScoring([score(candidates[0], { score: 9 })], {
    week: WEEK,
    candidates: [candidates[0]],
    interests,
  });
  expect(one.problems[0]).toMatch(/^Sesgo: 1 de 1 fichas \(100 %\)/);
});

test('el score es un entero de 1 a 10 y el agente uno de los conocidos', () => {
  for (const bad of [
    { score: 7.5 },
    { score: 0 },
    { score: 11 },
    { agent: 'human' },
    { unknown: 1 },
  ]) {
    const raw = valid([5, 5, 5, 5, 5, 5]);
    raw[0] = { ...raw[0], ...bad } as Scoring;
    expect(check(raw).problems, JSON.stringify(bad)).toHaveLength(1);
  }
});

test('no es un array o no es JSON: un único problema claro', async () => {
  expect(check({ candidateId: 'x' }).problems).toEqual([
    'scoring.json debe ser un array JSON con un objeto por ficha',
  ]);

  await seed();
  writeScoring('[{ esto no es json');
  await expect(validateBatch({ repoDir, week: WEEK })).rejects.toThrow(
    'scoring.json no es JSON válido',
  );
});

test('un batch vacío es válido cuando no hay fichas', async () => {
  await seed([]);
  writeScoring([]);
  const { summary } = await validateBatch({ repoDir, week: WEEK });
  expect(summary).toMatchObject({ total: 0, aboveThreshold: 0, high: 0 });
});

test('sin scoring.json o sin candidatos el error dice qué falta', async () => {
  await expect(validateBatch({ repoDir, week: WEEK })).rejects.toThrow(
    'No existe data/candidates/2026-W40.json',
  );
  await seed();
  await expect(validateBatch({ repoDir, week: WEEK })).rejects.toThrow(
    /No existe data[\\/]batches[\\/]2026-W40[\\/]scoring\.json: el evaluador debe escribirlo/,
  );
});

test('collect-batch guarda los scorings con id week:candidateId', async () => {
  await seed();
  writeScoring(
    valid([3, 5, 7, 7, 8, 4]).map((s, i) =>
      i === 2
        ? {
            ...s,
            riesgos: ['postinstall'],
            proyectosAfectados: ['SonarTrench'],
            usoBrowser: true,
          }
        : s,
    ),
  );

  const { summary } = await collectBatch({ repoDir, week: WEEK });
  expect(summary.total).toBe(6);

  const rows = db().select().from(scoringsTable).all();
  expect(rows).toHaveLength(6);
  const row = rows.find((r) => r.candidateId === candidates[2].id);
  expect(row).toMatchObject({
    id: `${WEEK}:${candidates[2].id}`,
    week: WEEK,
    agent: 'claude-code',
    score: 7,
    categoria: 'claude-skills',
    proyectosAfectados: ['SonarTrench'],
    riesgos: ['postinstall'],
    usoBrowser: true,
  });
});

test('repetir collect-batch tras corregir actualiza en vez de duplicar', async () => {
  await seed();
  writeScoring(valid([3, 5, 7, 7, 8, 4]));
  await collectBatch({ repoDir, week: WEEK });

  writeScoring(valid([3, 5, 7, 6, 8, 4]));
  await collectBatch({ repoDir, week: WEEK });

  const rows = db().select().from(scoringsTable).all();
  expect(rows).toHaveLength(6);
  expect(rows.map((r) => r.score).sort()).toEqual([3, 4, 5, 6, 7, 8]);
});

test('un batch rechazado no escribe nada en la base', async () => {
  await seed();
  writeScoring(valid([9, 9, 9, 9, 9, 9]));

  const failure = collectBatch({ repoDir, week: WEEK });
  await expect(failure).rejects.toBeInstanceOf(BatchRejectedError);
  await expect(failure).rejects.toThrow(
    'Batch 2026-W40 rechazado (1 problema)',
  );
  expect(db().select().from(scoringsTable).all()).toEqual([]);
});
