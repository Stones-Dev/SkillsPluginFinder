import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Scoring } from '../config/schema.js';
import type { Candidate } from '../normalize/candidate.js';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import { reviewFixtures } from '../testing/git-repo.js';
import {
  NOW,
  catalog,
  interestsYaml,
  realCandidates,
} from '../testing/real-data.js';
import {
  CONFIANZA_MARK,
  type CruceItem,
  DISPUTA_MARK,
  applyCruce,
  crossLine,
  crossScorings,
  crossWeek,
  cruceFile,
  cruceSchema,
  formatCross,
  leadingMarks,
  markFor,
  readCruce,
  stripMarks,
  summarizeCruce,
} from './cross.js';

const readJson = <T>(name: string) =>
  JSON.parse(fs.readFileSync(path.join(reviewFixtures, name), 'utf8')) as T;

// Las dos evaluaciones reales de la W40 (80 fichas): Claude Code y Antigravity (agy 1.2.14).
const claudeReal = readJson<Scoring[]>('scoring-cc-full-2026-W40.json');
const agyReal = readJson<Scoring[]>('scoring-ag-full-2026-W40.json');
const UMBRAL = 7;

test('con las 80 evaluaciones reales de la W40: 23 coinciden, 51 difieren 1-2 puntos y 6 están en disputa', () => {
  const items = crossScorings(claudeReal, agyReal);
  const s = summarizeCruce(items, UMBRAL);

  expect(s).toMatchObject({
    total: 80,
    cruzadas: 80,
    iguales: 23,
    cercanas: 51,
  });
  expect(s.disputas).toHaveLength(6);
  expect(s.confianzaAlta).toHaveLength(6);
  expect(
    s.disputas.every((d) => Math.abs(d.claude - (d.antigravity ?? 0)) >= 3),
  ).toBe(true);
  expect(s.disputas.map((d) => d.candidateId).sort()).toEqual([
    'github:assistant-ui/assistant-ui',
    'github:ateymoori/oh-my-android',
    'github:dotnet/benchmarkdotnet',
    'github:linq2db/linq2db',
    'github:lmnr-ai/lmnr',
    'github:microsoft/agent-framework',
  ]);
  // los 6 hallazgos que Claude Code había publicado tienen a Antigravity también en ≥ 7
  expect(s.confianzaAlta.map((d) => d.candidateId).sort()).toEqual([
    'github:andyshiu/claude-skill-playwright-browser',
    'github:crbnos/carbon',
    'github:kuratlielia/arc-library',
    'github:next-safe-action/next-safe-action',
    'github:solana-foundation/solana-web3.js',
    'github:solanabr/ai-kit',
  ]);
  // lo que cambia en el informe: 3 scores ≥ 7 que suben y 2 filas que cruzan el umbral
  expect(
    s.cambiaInforme.map((d) => [d.candidateId, d.claude, d.final]).sort(),
  ).toEqual([
    ['github:crbnos/carbon', 7, 7.5],
    ['github:insane0777/awwwards-mcp', 6, 7],
    ['github:next-safe-action/next-safe-action', 7, 8],
    ['github:open-mercato/open-mercato', 6, 7],
    ['github:solana-foundation/solana-web3.js', 7, 8],
  ]);
});

const sc = (id: string, score: number): Scoring => ({
  candidateId: id,
  week: '2026-W40',
  agent: 'claude-code',
  score,
  categoria: 'claude-skills',
  proyectosAfectados: [],
  porQue: 'Una razón concreta.',
  comoIntegrar: 'Probarlo.',
  riesgos: [],
  usoBrowser: false,
});
const pair = (cc: number, ag: number) =>
  crossScorings([sc('x', cc)], [{ ...sc('x', ag), agent: 'antigravity' }])[0];

test.each([
  // cc, ag, final, disputa, confianzaAlta
  [8, 4, 6, true, false],
  [8, 5, 6.5, true, false], // Δ 3: justo en el borde
  [8, 6, 7, false, false], // Δ 2: no es disputa
  [7, 7, 7, false, true],
  [7, 6, 6.5, false, false], // uno bajo 7: no hay confianza alta
  [9, 7, 8, false, true],
  [7, 8, 7.5, false, true],
  [2, 9, 5.5, true, false],
  [3, 3, 3, false, false],
])(
  'cruce de CC %i y AG %i → %s (disputa %s, confianza alta %s)',
  (cc, ag, final, disputa, alta) => {
    expect(pair(cc, ag)).toEqual({
      candidateId: 'x',
      claude: cc,
      antigravity: ag,
      final,
      disputa,
      confianzaAlta: alta,
    });
  },
);

test('sin Antigravity (null) se usa solo Claude Code: sin disputa ni confianza', () => {
  const items = crossScorings([sc('a', 9), sc('b', 2)], null);

  expect(items).toEqual([
    {
      candidateId: 'a',
      claude: 9,
      antigravity: null,
      final: 9,
      disputa: false,
      confianzaAlta: false,
    },
    {
      candidateId: 'b',
      claude: 2,
      antigravity: null,
      final: 2,
      disputa: false,
      confianzaAlta: false,
    },
  ]);
  expect(summarizeCruce(items, UMBRAL)).toMatchObject({
    cruzadas: 0,
    disputas: [],
    confianzaAlta: [],
    cambiaInforme: [],
  });
});

test('cambiaInforme: solo cuentan los scores ≥ umbral que cambian o que cruzan el umbral', () => {
  const items: CruceItem[] = [
    pair(7, 7), // igual: no cambia
    pair(7, 6), // 7 → 6.5: sale del umbral
    pair(6, 8), // 6 → 7: entra
    pair(4, 5), // 4 → 4.5: ni antes ni después ≥ 7
    pair(9, 9), // igual
  ].map((p, i) => ({ ...p, candidateId: `c${i}` }));

  expect(
    summarizeCruce(items, UMBRAL).cambiaInforme.map((i) => i.candidateId),
  ).toEqual(['c1', 'c2']);
});

test('las marcas de la nota: disputa, confianza alta y nada', () => {
  expect(markFor(pair(8, 4))).toBe(`${DISPUTA_MARK} CC 8 · AG 4 — `);
  expect(markFor(pair(8, 8))).toBe(`${CONFIANZA_MARK} CC 8 · AG 8 — `);
  expect(markFor(pair(5, 6))).toBe('');
  expect(markFor(undefined)).toBe('');
  expect(markFor({ ...pair(8, 8), antigravity: null })).toBe('');
});

test('stripMarks y leadingMarks quitan y devuelven solo las marcas del principio', () => {
  const nota = `${DISPUTA_MARK} CC 8 · AG 4 — Server Actions con zod · [[2026-W40]]`;

  expect(stripMarks(nota)).toBe('Server Actions con zod · [[2026-W40]]');
  expect(leadingMarks(nota)).toBe(`${DISPUTA_MARK} CC 8 · AG 4 — `);
  expect(stripMarks('Sin marcas')).toBe('Sin marcas');
  expect(leadingMarks('Sin marcas')).toBe('');
  // una mención en mitad de la nota no se toca
  expect(stripMarks(`Texto ${DISPUTA_MARK} CC 8 · AG 4 — final`)).toBe(
    `Texto ${DISPUTA_MARK} CC 8 · AG 4 — final`,
  );
});

test('crossLine: la línea del informe con las dos evaluaciones', () => {
  expect(crossLine(pair(8, 4))).toBe(
    '**Evaluación cruzada:** Claude Code 8 · Antigravity 4 → 6 · ⚖ disputa',
  );
  expect(crossLine(pair(8, 8))).toBe(
    '**Evaluación cruzada:** Claude Code 8 · Antigravity 8 → 8 · ✓ confianza alta',
  );
  expect(crossLine(pair(5, 6))).toBe(
    '**Evaluación cruzada:** Claude Code 5 · Antigravity 6 → 5.5',
  );
  expect(crossLine({ ...pair(5, 6), antigravity: null })).toBeNull();
  expect(crossLine(undefined)).toBeNull();
});

test('applyCruce pone el score final; si el cruce no corresponde a los scorings, falla', () => {
  const scorings = [sc('a', 8), sc('b', 5)];
  const cruce = {
    version: 1 as const,
    week: '2026-W40',
    generatedAt: NOW.toISOString(),
    fuentes: ['claude-code', 'antigravity'] as (
      | 'claude-code'
      | 'antigravity'
    )[],
    umbral: UMBRAL,
    items: crossScorings(scorings, [
      { ...sc('a', 4), agent: 'antigravity' },
      { ...sc('b', 5), agent: 'antigravity' },
    ]),
  };

  expect(applyCruce(scorings, cruce).map((s) => s.score)).toEqual([6, 5]);
  expect(() => applyCruce([sc('a', 9), sc('b', 5)], cruce)).toThrow(
    /desfasado.*vuelve a ejecutar spf cross/,
  );
  expect(() => applyCruce([sc('z', 5)], cruce)).toThrow(/desfasado/);
});

// --- crossWeek: valida y escribe cruce.json ----------------------------------

const WEEK = '2026-W40';
const candidates: Candidate[] = realCandidates().slice(0, 6);
let repoDir: string;
beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-cross-'));
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
  fs.rmSync(repoDir, { recursive: true, force: true });
});

const write = (file: string, agent: Scoring['agent'], values: number[]) => {
  const dir = path.join(repoDir, 'data', 'batches', WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    JSON.stringify(
      candidates.map((c, i) => ({ ...sc(c.id, values[i]), agent })),
    ),
  );
};

test('crossWeek con las dos evaluaciones: escribe cruce.json válido con la media y las marcas', async () => {
  write('scoring.json', 'claude-code', [9, 8, 7, 5, 4, 3]);
  write('scoring-antigravity.json', 'antigravity', [5, 8, 7, 6, 4, 2]);

  const r = await crossWeek({ repoDir, week: WEEK, now: NOW });

  expect(r.antigravityError).toBeUndefined();
  expect(r.cruce.fuentes).toEqual(['claude-code', 'antigravity']);
  expect(r.cruce.umbral).toBe(7);
  expect(
    r.cruce.items.map((i) => [i.final, i.disputa, i.confianzaAlta]),
  ).toEqual([
    [7, true, false],
    [8, false, true],
    [7, false, true],
    [5.5, false, false],
    [4, false, false],
    [2.5, false, false],
  ]);
  const onDisk = await readCruce(repoDir, WEEK);
  expect(onDisk).toEqual(r.cruce);
  expect(
    cruceSchema.parse(
      JSON.parse(fs.readFileSync(cruceFile(repoDir, WEEK), 'utf8')),
    ),
  ).toEqual(r.cruce);
  const text = formatCross(r).join('\n');
  expect(text).toContain(
    'Cruce 2026-W40: Claude Code + Antigravity (6 fichas)',
  );
  expect(text).toContain(
    'coinciden en el score:  3 · difieren 1-2 puntos:  2 · desacuerdo ≥ 3:  1',
  );
  expect(text).toContain(`${candidates[0].name} — CC 9 · AG 5 → 7`);
  expect(text).toContain('publicación: cambia');
});

test('crossWeek sin scoring-antigravity.json sigue solo con Claude Code y lo dice', async () => {
  write('scoring.json', 'claude-code', [9, 8, 7, 5, 4, 3]);

  const r = await crossWeek({ repoDir, week: WEEK, now: NOW });

  expect(r.cruce.fuentes).toEqual(['claude-code']);
  expect(r.antigravityError).toContain('scoring-antigravity.json');
  expect(r.cruce.items.every((i) => i.antigravity === null && !i.disputa)).toBe(
    true,
  );
  const text = formatCross(r).join('\n');
  expect(text).toContain('solo Claude Code (6 fichas)');
  expect(text).toContain('Antigravity no aporta evaluación');
  expect(text).toContain('publicación: sin cambios');
});

test('crossWeek con un scoring-antigravity.json que no valida también sigue solo con Claude Code', async () => {
  write('scoring.json', 'claude-code', [9, 8, 7, 5, 4, 3]);
  write('scoring-antigravity.json', 'claude-code', [5, 5, 5, 5, 5, 5]); // agente equivocado

  const r = await crossWeek({ repoDir, week: WEEK, now: NOW });

  expect(r.cruce.fuentes).toEqual(['claude-code']);
  expect(r.antigravityError).toContain('rechazado');
});

test('crossWeek sin el scoring.json de Claude Code falla: no hay nada que cruzar', async () => {
  write('scoring-antigravity.json', 'antigravity', [5, 5, 5, 5, 5, 5]);

  await expect(crossWeek({ repoDir, week: WEEK })).rejects.toThrow(
    /No existe .*scoring\.json/,
  );
});

test('readCruce devuelve null sin fichero y rechaza uno que no cumple el esquema', async () => {
  expect(await readCruce(repoDir, WEEK)).toBeNull();
  fs.mkdirSync(path.join(repoDir, 'data', 'batches', WEEK), {
    recursive: true,
  });
  fs.writeFileSync(cruceFile(repoDir, WEEK), '{"version":2}');

  await expect(readCruce(repoDir, WEEK)).rejects.toThrow(
    /no cumple el esquema.*spf cross/,
  );
});
