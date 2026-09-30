import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import { type Candidate, normalizeGithubRepo } from '../normalize/index.js';
import { extractYamlBlock } from '../vault/markdown.js';
import { allocateQuota, selectForEnrichment } from './quota.js';

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

test('invariantes en 300 casos pseudoaleatorios reproducibles', () => {
  let seed = 20260930;
  const rnd = (max: number) => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed % (max + 1);
  };

  for (let i = 0; i < 300; i++) {
    const n = 1 + rnd(8);
    const sizes: Record<string, number> = {};
    const weights: Record<string, number> = {};
    for (let k = 0; k < n; k++) {
      sizes[`c${k}`] = rnd(60);
      weights[`c${k}`] = rnd(10) / 10;
    }
    const total = rnd(150);
    const alloc = allocateQuota(sizes, weights, total);

    const demand = Object.values(sizes).reduce((a, b) => a + b, 0);
    const given = Object.values(alloc).reduce((a, b) => a + b, 0);
    expect(given).toBe(Math.min(total, demand));
    for (const k of Object.keys(sizes)) {
      expect(alloc[k]).toBeGreaterThanOrEqual(0);
      expect(alloc[k]).toBeLessThanOrEqual(sizes[k]);
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

test('selectForEnrichment: cuota por peso, sin pasarse del tope y sin perder candidatos', () => {
  const { selected, deferred } = selectForEnrichment(
    pool,
    { ...interests, enrich_max: 12 },
    NOW,
  );
  const count = (cat: string) =>
    selected.filter((c) => c.categoriaSugerida === cat).length;

  // 12 × (1.0, 0.8, 0.7)/2.5 = 4,8 / 3,84 / 3,36 → 5 / 4 / 3 por mayor resto
  expect([
    count('claude-skills'),
    count('agent-skills'),
    count('rust'),
  ]).toEqual([5, 4, 3]);
  expect(selected).toHaveLength(12);
  expect(selected.length + deferred.length).toBe(30);
  expect(
    new Set([...selected.map((c) => c.id), ...deferred.map((d) => d.id)]).size,
  ).toBe(30);
  // categorías por peso descendente
  expect(selected.map((c) => c.categoriaSugerida)).toEqual([
    ...Array(5).fill('claude-skills'),
    ...Array(4).fill('agent-skills'),
    ...Array(3).fill('rust'),
  ]);
  expect(deferred[0]).toMatchObject({
    categoria: 'claude-skills',
    motivo: 'tope enrich_max=12: cuota de claude-skills = 5 de 10',
  });
});

test('dentro de la categoría van primero los creados en la ventana y luego por estrellas', () => {
  const skills = pool.filter((c) => c.categoriaSugerida === 'claude-skills');
  const lowStars = skills.reduce((min, c) => (c.stars < min.stars ? c : min));
  const promoted = {
    ...lowStars,
    createdAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const candidates = skills.map((c) => (c.id === lowStars.id ? promoted : c));

  const { selected } = selectForEnrichment(
    candidates,
    { ...interests, enrich_max: 3 },
    NOW,
  );

  expect(selected[0].id).toBe(lowStars.id); // el nuevo, aunque tenga menos estrellas
  const rest = selected.slice(1).map((c) => c.stars);
  expect(rest).toEqual([...rest].sort((a, b) => b - a));
  const others = candidates
    .filter((c) => c.id !== lowStars.id)
    .map((c) => c.stars);
  expect(rest).toEqual(others.sort((a, b) => b - a).slice(0, 2));
});

test('con menos candidatos que plazas entra todo y no hay diferidos', () => {
  const { selected, deferred } = selectForEnrichment(pool, interests, NOW);
  expect(selected).toHaveLength(30);
  expect(deferred).toEqual([]);
});
