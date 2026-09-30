import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import { filterCandidates } from '../filter/index.js';
import { type Candidate, normalizeGithubRepo } from '../normalize/index.js';
import { parseCatalog } from '../vault/catalogo.js';
import { extractYamlBlock } from '../vault/markdown.js';
import {
  MIN_SLOTS_PER_CATEGORY,
  allocateQuota,
  allocateSlots,
  selectForEnrichment,
} from './quota.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const read = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8').replace(/\r\n/g, '\n');
const items = JSON.parse(read('github-search/response.json'))
  .items as GithubRepo[];
const interests = parseInterestsYaml(
  extractYamlBlock(read('vault/Intereses.md')).body,
  'Intereses.md',
);
const catalog = parseCatalog(read('vault/Catalogo.md'));
const NOW = new Date('2026-09-30T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

test('allocateQuota reparte en proporción al peso', () => {
  expect(
    allocateQuota({ a: 100, b: 100, c: 100 }, { a: 1, b: 0.5, c: 0.5 }, 80),
  ).toEqual({ a: 40, b: 20, c: 20 });
});

test('lo que una categoría no puede llenar se redistribuye entre las demás', () => {
  expect(allocateQuota({ a: 10, b: 100 }, { a: 1, b: 1 }, 80)).toEqual({
    a: 10,
    b: 70,
  });
  expect(
    allocateQuota({ a: 2, b: 3, c: 100 }, { a: 1, b: 1, c: 1 }, 30),
  ).toEqual({ a: 2, b: 3, c: 25 });
});

test('si hay plazas de sobra entra todo, y con total 0 no entra nada', () => {
  expect(allocateQuota({ a: 3, b: 2 }, { a: 1, b: 1 }, 80)).toEqual({
    a: 3,
    b: 2,
  });
  expect(allocateQuota({ a: 3, b: 2 }, { a: 1, b: 1 }, 0)).toEqual({
    a: 0,
    b: 0,
  });
  expect(allocateQuota({}, {}, 10)).toEqual({});
});

test('el resto entero va por mayor resto y el empate por peso y luego por id', () => {
  // 80/3 = 26,67 cada una: dos categorías reciben 27, una 26 (gana a, luego b)
  expect(
    allocateQuota({ c: 100, a: 100, b: 100 }, { a: 1, b: 1, c: 1 }, 80),
  ).toEqual({ a: 27, b: 27, c: 26 });
  // con pesos distintos gana el mayor peso
  expect(
    allocateQuota({ a: 100, b: 100, c: 100 }, { a: 1, b: 1, c: 1.0001 }, 80),
  ).toMatchObject({ c: 27 });
});

test('una categoría con peso 0 no rompe el reparto y solo recibe lo que sobra', () => {
  expect(allocateQuota({ a: 5, b: 5 }, { a: 1, b: 0 }, 5)).toEqual({
    a: 5,
    b: 0,
  });
  expect(allocateQuota({ a: 2, b: 5 }, { a: 1, b: 0 }, 5)).toEqual({
    a: 2,
    b: 3,
  });
});

// Generador reproducible para los invariantes.
function randomCases(seed: number, count: number) {
  let state = seed;
  const rnd = (max: number) => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state % (max + 1);
  };
  return Array.from({ length: count }, () => {
    const n = 1 + rnd(8);
    const sizes: Record<string, number> = {};
    const weights: Record<string, number> = {};
    for (let k = 0; k < n; k++) {
      sizes[`c${k}`] = rnd(60);
      weights[`c${k}`] = rnd(10) / 10;
    }
    return { sizes, weights, total: rnd(150) };
  });
}

test('invariantes de allocateQuota en 300 casos pseudoaleatorios reproducibles', () => {
  for (const { sizes, weights: w, total } of randomCases(20260930, 300)) {
    const alloc = allocateQuota(sizes, w, total);

    const demand = Object.values(sizes).reduce((a, b) => a + b, 0);
    const given = Object.values(alloc).reduce((a, b) => a + b, 0);
    expect(given).toBe(Math.min(total, demand));
    for (const k of Object.keys(sizes)) {
      expect(alloc[k]).toBeGreaterThanOrEqual(0);
      expect(alloc[k]).toBeLessThanOrEqual(sizes[k]);
    }
  }
});

// Tamaños reales de la primera ejecución (2026-09-30): 610 elegibles en 10
// categorías, de las que solo entraron 80. Los pesos son los de Intereses.
const FIRST_RUN_SIZES = {
  'claude-skills': 98,
  'mcp-servers': 63,
  'frontend-bonito': 107,
  'nextjs-react': 35,
  'agent-skills': 74,
  solana: 40,
  rust: 45,
  sage200: 62,
  dotnet: 51,
  'librerias-relacionadas': 35,
};
const weights = Object.fromEntries(
  Object.entries(interests.categorias).map(([id, c]) => [id, c.peso]),
);

test('allocateSlots con los tamaños reales de la primera ejecución: suma 80 y mínimo 3 por categoría', () => {
  // 30 plazas van a los mínimos y las 50 restantes se reparten por peso × elegibles
  expect(allocateSlots(FIRST_RUN_SIZES, weights, 80)).toEqual({
    'claude-skills': 13,
    'mcp-servers': 9,
    'frontend-bonito': 13,
    'nextjs-react': 6,
    'agent-skills': 9,
    solana: 6,
    rust: 6,
    sage200: 7,
    dotnet: 6,
    'librerias-relacionadas': 5,
  });
  // el reparto solo por peso daba 11 a claude-skills (98 elegibles) y 9 a nextjs-react (35)
  expect(allocateQuota(FIRST_RUN_SIZES, weights, 80)).toMatchObject({
    'claude-skills': 11,
    'nextjs-react': 9,
  });
});

test('allocateSlots: el mínimo es todo lo que hay si hay menos de 3, y si el tope no da para los mínimos se reparte por peso', () => {
  expect(
    allocateSlots({ a: 1, b: 2, c: 50 }, { a: 1, b: 1, c: 1 }, 10),
  ).toEqual({ a: 1, b: 2, c: 7 });
  // 30 mínimos no caben en 20 plazas: sale el mismo reparto que por peso, limitado a 3
  const few = allocateSlots(FIRST_RUN_SIZES, weights, 20);
  expect(Object.values(few).reduce((a, b) => a + b, 0)).toBe(20);
  expect(Math.max(...Object.values(few))).toBeLessThanOrEqual(
    MIN_SLOTS_PER_CATEGORY,
  );
  expect(few['claude-skills']).toBe(3);
  expect(few['librerias-relacionadas']).toBe(1);
  // sin elegibles no hay plazas, y con total 0 no entra nada
  expect(allocateSlots({ a: 0, b: 5 }, { a: 1, b: 1 }, 10)).toEqual({
    a: 0,
    b: 5,
  });
  expect(allocateSlots({ a: 5, b: 5 }, { a: 1, b: 1 }, 0)).toEqual({
    a: 0,
    b: 0,
  });
});

test('invariantes de allocateSlots en 300 casos pseudoaleatorios reproducibles', () => {
  for (const { sizes, weights: w, total } of randomCases(20261001, 300)) {
    const alloc = allocateSlots(sizes, w, total);

    const demand = Object.values(sizes).reduce((a, b) => a + b, 0);
    const given = Object.values(alloc).reduce((a, b) => a + b, 0);
    expect(given).toBe(Math.min(total, demand));

    const floors = Object.values(sizes).reduce(
      (sum, n) => sum + Math.min(n, MIN_SLOTS_PER_CATEGORY),
      0,
    );
    for (const k of Object.keys(sizes)) {
      expect(alloc[k]).toBeLessThanOrEqual(sizes[k]);
      // con tope suficiente, ninguna categoría con elegibles baja de su mínimo
      if (total >= floors) {
        expect(alloc[k]).toBeGreaterThanOrEqual(
          Math.min(sizes[k], MIN_SLOTS_PER_CATEGORY),
        );
      }
    }
  }
});

// 30 repos reales repartidos en tres categorías de pesos 1.0 / 0.8 / 0.7.
const inCategory = (categoria: string, from: number, to: number) =>
  items.slice(from, to).map((repo): Candidate => {
    const c = normalizeGithubRepo(
      { repo, origins: [{ categoria, tipo: 'keyword', query: 'x' }] },
      { interests, now: NOW },
    );
    return { ...c, categoriaSugerida: categoria };
  });
const pool = [
  ...inCategory('claude-skills', 0, 10),
  ...inCategory('agent-skills', 10, 20),
  ...inCategory('rust', 20, 30),
];

test('selectForEnrichment: plazas por peso × elegibles, sin pasarse del tope y sin perder candidatos', () => {
  const { selected, deferred } = selectForEnrichment(
    pool,
    { ...interests, enrich_max: 12 },
    NOW,
  );
  const count = (cat: string) =>
    selected.filter((c) => c.categoriaSugerida === cat).length;

  // 9 plazas de mínimos (3 por categoría) y 3 más en proporción a 10 / 8 / 7
  // (1,2 / 0,96 / 0,84): la primera se lleva 1 y el mayor resto reparte las otras 2
  expect([
    count('claude-skills'),
    count('agent-skills'),
    count('rust'),
  ]).toEqual([4, 4, 4]);
  expect(selected).toHaveLength(12);
  expect(selected.length + deferred.length).toBe(30);
  expect(
    new Set([...selected.map((c) => c.id), ...deferred.map((d) => d.id)]).size,
  ).toBe(30);
  // categorías por peso descendente
  expect(selected.map((c) => c.categoriaSugerida)).toEqual([
    ...Array(4).fill('claude-skills'),
    ...Array(4).fill('agent-skills'),
    ...Array(4).fill('rust'),
  ]);
  expect(deferred[0]).toMatchObject({
    categoria: 'claude-skills',
    motivo: 'tope enrich_max=12: cuota de claude-skills = 4 de 10',
  });
});

test('dentro de la categoría van primero los creados en la ventana y luego los de pushed más reciente, sin mirar estrellas', () => {
  const skills = pool.filter((c) => c.categoriaSugerida === 'claude-skills');
  // zLanqing/codex-claude-academic-skills: 4.433★, el de menos estrellas y push de mayo
  const lowStars = skills.reduce((min, c) => (c.stars < min.stars ? c : min));
  const promoted = {
    ...lowStars,
    createdAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
  };
  const candidates = skills.map((c) => (c.id === lowStars.id ? promoted : c));

  const { selected } = selectForEnrichment(
    candidates,
    { ...interests, enrich_max: 3 },
    NOW,
  );

  expect(selected[0].id).toBe(lowStars.id); // el nuevo, aunque tenga menos estrellas

  const others = candidates.filter((c) => c.id !== lowStars.id);
  const byPushed = [...others].sort(
    (a, b) => Date.parse(b.lastCommitAt) - Date.parse(a.lastCommitAt),
  );
  const byStars = [...others].sort((a, b) => b.stars - a.stars);
  // el dato real distingue los dos criterios: si no, este test no probaría nada
  expect(byPushed.slice(0, 2).map((c) => c.id)).not.toEqual(
    byStars.slice(0, 2).map((c) => c.id),
  );
  expect(selected.slice(1).map((c) => c.id)).toEqual(
    byPushed.slice(0, 2).map((c) => c.id),
  );
});

test('con menos candidatos que plazas entra todo y no hay diferidos', () => {
  const { selected, deferred } = selectForEnrichment(pool, interests, NOW);
  expect(selected).toHaveLength(30);
  expect(deferred).toEqual([]);
});

test('con las reglas de hoy el tope ya no se llena de gigantes: los 30 reales pasan el filtro y la selección sin nada por encima de 20.000★', () => {
  const normalized = items.map((repo) =>
    normalizeGithubRepo(
      {
        repo,
        origins: [{ categoria: 'claude-skills', tipo: 'keyword', query: 'x' }],
      },
      { interests, now: NOW },
    ),
  );
  const { kept } = filterCandidates(normalized, interests, catalog, NOW);
  const { selected, deferred } = selectForEnrichment(
    kept,
    { ...interests, enrich_max: 8 },
    NOW,
  );

  expect(kept).toHaveLength(11);
  expect(selected).toHaveLength(8);
  expect(deferred).toHaveLength(3);
  expect(Math.max(...selected.map((c) => c.stars))).toBeLessThanOrEqual(20000);
  // el de ykdojo es NOASSERTION: ya no se descarta
  expect(kept.map((c) => c.name)).toContain('ykdojo/claude-code-tips');
});
