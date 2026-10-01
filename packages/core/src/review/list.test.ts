import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Scoring } from '../config/schema.js';
import { parseCatalog } from '../vault/catalogo.js';
import {
  formatReviewList,
  listForReview,
  repoFromReviewId,
  reviewCandidates,
} from './list.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const catalogText = fs
  .readFileSync(path.join(fixtures, 'vault/Catalogo-W40.md'), 'utf8')
  .replace(/\r\n/g, '\n');
const scoringText = fs.readFileSync(
  path.join(fixtures, 'review/scoring-2026-W40.json'),
  'utf8',
);
// Los 6 scorings reales de la W40 que acabaron en el catálogo como `candidato`.
const scorings = JSON.parse(scoringText) as Scoring[];

const catalog = parseCatalog(catalogText);
const byWeek = new Map([['2026-W40', scorings]]);

test('con el catálogo real: los 6 hallazgos de la W40, de mayor a menor score, con su proyecto afectado', () => {
  const { items, sinRepo } = reviewCandidates(catalog, byWeek);

  expect(sinRepo).toEqual([]);
  expect(items.map((i) => [i.id, i.score])).toEqual([
    ['github:solanabr/ai-kit', 8],
    ['github:andyshiu/claude-skill-playwright-browser', 7],
    ['github:crbnos/carbon', 7],
    ['github:kuratlielia/arc-library', 7],
    ['github:next-safe-action/next-safe-action', 7],
    ['github:solana-foundation/solana-web3.js', 7],
  ]);
  expect(items[0]).toEqual({
    id: 'github:solanabr/ai-kit',
    nombre: 'solanabr/ai-kit',
    categoria: 'solana',
    score: 8,
    semana: '2026-W40',
    proyectos: ['SonarTrench'],
    url: 'https://github.com/solanabr/ai-kit',
  });
  expect(items[1].proyectos).toEqual([
    'LABE Abogados web',
    'CRMDecoversia',
    'Auditor Web MCP',
  ]);
  expect(items.find((i) => i.nombre === 'crbnos/carbon')).toMatchObject({
    categoria: 'sage200',
    proyectos: ['Sage 200 MCP'],
  });
});

test('las 9 filas del baseline (adoptado/descartado) no aparecen', () => {
  const { items } = reviewCandidates(catalog, byWeek);
  const baseline = catalog.filter((e) => e.semana === 'baseline');

  expect(baseline).toHaveLength(9);
  for (const row of baseline) {
    expect(items.map((i) => i.nombre)).not.toContain(row.nombre);
  }
});

test('un hallazgo que ya no es candidato desaparece de la lista', () => {
  const adopted = catalogText.replace(
    '| next-safe-action/next-safe-action | library | nextjs-react | candidato |',
    '| next-safe-action/next-safe-action | library | nextjs-react | adoptado |',
  );
  expect(adopted).not.toBe(catalogText);

  const { items } = reviewCandidates(parseCatalog(adopted), byWeek);

  expect(items).toHaveLength(5);
  expect(items.map((i) => i.nombre)).not.toContain(
    'next-safe-action/next-safe-action',
  );
});

test('sin scoring de esa semana el proyecto queda vacío, no falla', () => {
  const { items } = reviewCandidates(catalog, new Map());

  expect(items).toHaveLength(6);
  expect(items.every((i) => i.proyectos.length === 0)).toBe(true);
});

test('una fila candidato sin enlace de GitHub se avisa y no se lista', () => {
  const rows = parseCatalog(
    `${catalogText.trimEnd()}\n| Algo sin enlace | skill | claude-skills | candidato | 2026-W40 | 7 | Nota | — |\n`,
  );

  const { items, sinRepo } = reviewCandidates(rows, byWeek);

  expect(items).toHaveLength(6);
  expect(sinRepo).toEqual(['Algo sin enlace']);
  expect(formatReviewList({ items, sinRepo }).join('\n')).toContain(
    '"Algo sin enlace" está en candidato',
  );
});

test('repoFromReviewId acepta el id que imprime --list y rechaza el resto', () => {
  expect(repoFromReviewId('github:SolanaBR/ai-kit')).toBe('solanabr/ai-kit');
  for (const bad of ['solanabr/ai-kit', 'github:x', 'github:a/b/c', '']) {
    expect(() => repoFromReviewId(bad)).toThrow(/Id no válido/);
  }
});

test('formatReviewList imprime id, categoría, score, proyectos y URL', () => {
  const text = formatReviewList(reviewCandidates(catalog, byWeek)).join('\n');

  expect(text).toContain('6 hallazgos en estado candidato');
  expect(text).toContain('github:solanabr/ai-kit');
  expect(text).toContain('categoría solana · score 8 · 2026-W40');
  expect(text).toContain('proyectos: SonarTrench');
  expect(text).toContain('https://github.com/solanabr/ai-kit');
});

test('formatReviewList con la lista vacía lo dice', () => {
  expect(formatReviewList({ items: [], sinRepo: [] })).toEqual([
    'Ningún hallazgo en estado candidato.',
  ]);
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-review-list-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('listForReview lee Catalogo.md del vault y data/batches/<semana>/scoring.json del repo', async () => {
  const repoDir = path.join(tmp, 'repo');
  const vaultDir = path.join(tmp, 'vault');
  fs.mkdirSync(path.join(repoDir, 'data', 'batches', '2026-W40'), {
    recursive: true,
  });
  fs.mkdirSync(vaultDir);
  fs.writeFileSync(
    path.join(repoDir, 'data', 'batches', '2026-W40', 'scoring.json'),
    scoringText,
  );
  fs.writeFileSync(path.join(vaultDir, 'Catalogo.md'), catalogText);

  const { items } = await listForReview({ repoDir, vaultDir });

  expect(items).toHaveLength(6);
  expect(items[0]).toMatchObject({
    id: 'github:solanabr/ai-kit',
    proyectos: ['SonarTrench'],
  });
});

test('listForReview sin scoring.json de la semana lista igualmente (proyectos vacíos)', async () => {
  const repoDir = path.join(tmp, 'repo');
  const vaultDir = path.join(tmp, 'vault');
  fs.mkdirSync(repoDir);
  fs.mkdirSync(vaultDir);
  fs.writeFileSync(path.join(vaultDir, 'Catalogo.md'), catalogText);

  const { items } = await listForReview({ repoDir, vaultDir });

  expect(items).toHaveLength(6);
  expect(items.every((i) => i.proyectos.length === 0)).toBe(true);
});

test('listForReview con un scoring.json que rompe el esquema falla con el fichero en el mensaje', async () => {
  const repoDir = path.join(tmp, 'repo');
  const vaultDir = path.join(tmp, 'vault');
  fs.mkdirSync(path.join(repoDir, 'data', 'batches', '2026-W40'), {
    recursive: true,
  });
  fs.mkdirSync(vaultDir);
  fs.writeFileSync(
    path.join(repoDir, 'data', 'batches', '2026-W40', 'scoring.json'),
    '[{"candidateId":"x"}]',
  );
  fs.writeFileSync(path.join(vaultDir, 'Catalogo.md'), catalogText);

  await expect(listForReview({ repoDir, vaultDir })).rejects.toThrow(
    /scoring\.json no cumple el esquema/,
  );
});
