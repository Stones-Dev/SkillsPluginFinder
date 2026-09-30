import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import { closeDatabases, getDb } from '../db/index.js';
import { extractYamlBlock } from '../vault/markdown.js';
import {
  type Origin,
  candidateSchema,
  classifyKind,
  dedupeCandidates,
  markAsSeen,
  normalizeGithubRepo,
  suggestCategory,
} from './index.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const items = JSON.parse(
  fs.readFileSync(path.join(fixtures, 'github-search/response.json'), 'utf8'),
).items as GithubRepo[];
const interests = parseInterestsYaml(
  extractYamlBlock(
    fs
      .readFileSync(path.join(fixtures, 'vault/Intereses.md'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ).body,
  'Intereses.md',
);

const NOW = new Date('2026-09-30T12:00:00Z');
const item = (fullName: string) => {
  const found = items.find((i) => i.full_name === fullName);
  if (!found) throw new Error(`${fullName} no está en el fixture`);
  return found;
};
const fromClaudeSkills: Origin = {
  categoria: 'claude-skills',
  tipo: 'keyword',
  query: 'claude code skill',
};
const normalize = (repo: GithubRepo, origins: Origin[] = [fromClaudeSkills]) =>
  normalizeGithubRepo({ repo, origins }, { interests, now: NOW });

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-norm-'));
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('normalizeGithubRepo mapea un repo real al Candidate del Plan §4', () => {
  const c = normalize(item('alirezarezvani/claude-skills'));

  expect(candidateSchema.parse(c)).toEqual(c);
  expect(c).toMatchObject({
    id: 'github:alirezarezvani/claude-skills',
    name: 'alirezarezvani/claude-skills',
    url: 'https://github.com/alirezarezvani/claude-skills',
    source: 'github-search',
    // su descripción dice "skills & agent skills & plugins": plugin > skill
    kind: 'plugin',
    stars: 26974,
    license: 'MIT',
    createdAt: '2025-10-19T04:04:05Z',
    lastCommitAt: '2026-08-30T09:46:16Z',
    archived: false,
    fork: false,
    categoriaSugerida: 'claude-skills',
    foundAt: NOW.toISOString(),
    risk: { ageDays: 346, notes: [] },
  });
  expect(c.topics).toContain('claude-skills');
  expect(c.origins).toEqual([fromClaudeSkills]);
});

test('el id es estable entre ejecuciones (mismo repo, mismo id) y no depende de las mayúsculas', () => {
  const a = normalize(item('Jeffallan/claude-skills'));
  const b = normalize(item('Jeffallan/claude-skills'));
  expect(a.id).toBe(b.id);
  expect(a.id).toBe('github:jeffallan/claude-skills');
  expect(a.name).toBe('Jeffallan/claude-skills');
});

test('la licencia: MIT, NOASSERTION se conserva y sin licencia queda sin definir', () => {
  expect(normalize(item('Jeffallan/claude-skills')).license).toBe('MIT');
  expect(normalize(item('Imbad0202/academic-research-skills')).license).toBe(
    'NOASSERTION',
  );
  expect(
    normalize(item('multica-ai/andrej-karpathy-skills')).license,
  ).toBeUndefined();
});

test('descripción y topics nulos se normalizan', () => {
  const repo = {
    ...item('Jeffallan/claude-skills'),
    description: null,
    topics: undefined,
  };
  const c = normalize(repo as unknown as GithubRepo);
  expect(c.description).toBe('');
  expect(c.topics).toEqual([]);
  expect(candidateSchema.safeParse(c).success).toBe(true);
});

test('todos los repos reales del fixture producen candidatos válidos', () => {
  for (const repo of items) {
    expect(() => candidateSchema.parse(normalize(repo))).not.toThrow();
  }
});

test('classifyKind manda lo que el repo dice de sí mismo; los topics solo desempatan lo que no dice nada', () => {
  // Con los topics por delante, estos tres repos reales salían como
  // mcp-server / mcp-server / agent-skill (etiquetas de relleno).
  for (const name of [
    'zebbern/claude-code-guide', // guía con el topic "mcp"
    'wanshuiyin/Auto-claude-code-research-in-sleep', // "Markdown-only skills", topic "mcp-server"
    'virgiliojr94/book-to-skill', // "…into a Claude Code skill", topic "agent-skills"
  ]) {
    expect(normalize(item(name)).kind).toBe('skill');
  }

  const kind = (topics: string[]) =>
    classifyKind({ name: 'x/y', description: 'Nada dice el texto', topics });
  expect(kind(['mcp-server'])).toBe('mcp-server'); // texto mudo: decide el topic
  expect(kind([])).toBe('library');
});

test('classifyKind: mcp > plugin > agent-skill > skill > template > library', () => {
  const kind = (name: string, description = '', topics: string[] = []) =>
    classifyKind({ name, description, topics });

  expect(kind('punkpeye/awesome-mcp-servers')).toBe('mcp-server');
  expect(kind('x/claude-code-plugins')).toBe('plugin');
  expect(kind('x/y', 'Cross-tool agent skills')).toBe('agent-skill');
  expect(kind('x/y', 'Cross-tool skills', ['agent-skills'])).toBe('skill');
  expect(kind('Jeffallan/claude-skills')).toBe('skill');
  expect(kind('x/next-starter')).toBe('template');
  expect(kind('x/zod-utils', 'Helpers for zod')).toBe('library');
  // precedencia: un servidor MCP de skills es un servidor MCP
  expect(kind('x/skills-mcp-server')).toBe('mcp-server');
  // sin falsos positivos por subcadenas
  expect(kind('x/pluginless-thing')).toBe('library');
});

test('suggestCategory: consultas de origen pesan más que los topics y estos más que las keywords', () => {
  const only = (
    categoria: string,
    tipo: Origin['tipo'] = 'keyword',
  ): Origin => ({
    categoria,
    tipo,
    query: 'x',
  });
  const input = (over: Partial<Parameters<typeof suggestCategory>[0]>) => ({
    name: 'x/y',
    description: '',
    topics: [],
    origins: [],
    ...over,
  });

  // 3 (origen mcp-servers) frente a 2 (topic de claude-skills)
  expect(
    suggestCategory(
      input({ origins: [only('mcp-servers')], topics: ['claude-code'] }),
      interests,
    ).categoria,
  ).toBe('mcp-servers');
  // 3+2 (origen + topic) gana a 3
  expect(
    suggestCategory(
      input({
        origins: [only('mcp-servers'), only('claude-skills')],
        topics: ['claude-code'],
      }),
      interests,
    ).categoria,
  ).toBe('claude-skills');
  // 1 punto por keyword presente en la descripción
  expect(
    suggestCategory(
      input({ description: 'A tokio based runtime', origins: [] }),
      interests,
    ).categoria,
  ).toBe('rust');
});

test('suggestCategory: el empate se resuelve por peso y luego por id; alternativas solo con score > 0', () => {
  const origin = (categoria: string): Origin => ({
    categoria,
    tipo: 'topic',
    query: 'x',
  });
  const base = { name: 'x/y', description: '', topics: [] as string[] };

  // solana (peso 0.8) > rust (peso 0.7)
  const byWeight = suggestCategory(
    { ...base, origins: [origin('rust'), origin('solana')] },
    interests,
  );
  expect(byWeight).toEqual({ categoria: 'solana', alternativas: ['rust'] });

  // claude-skills y mcp-servers tienen peso 1.0: gana el id menor
  const byId = suggestCategory(
    { ...base, origins: [origin('mcp-servers'), origin('claude-skills')] },
    interests,
  );
  expect(byId.categoria).toBe('claude-skills');

  expect(
    suggestCategory({ ...base, origins: [] }, { ...interests, categorias: {} }),
  ).toEqual({
    categoria: 'sin-categoria',
    alternativas: [],
  });
});

test('la categoría sugerida de repos reales sigue a su consulta de origen', () => {
  const c = normalize(item('Jeffallan/claude-skills'));
  expect(c.categoriaSugerida).toBe('claude-skills');
  expect(c.categoriasAlternativas.length).toBeLessThanOrEqual(3);
  expect(c.categoriasAlternativas).not.toContain(c.categoriaSugerida);
});

test('dedupe: descarta lo ya visto por id y solo lo marcado, en una base real', async () => {
  const db = getDb(path.join(tmp, 'seen.sqlite'));
  const [a, b, c] = [
    'Jeffallan/claude-skills',
    'coreyhaines31/marketingskills',
    'daymade/claude-code-skills',
  ].map((n) => normalize(item(n)));

  expect(await dedupeCandidates([a, b, c], db)).toHaveLength(3);
  await markAsSeen([a.id, c.id], db);
  expect((await dedupeCandidates([a, b, c], db)).map((x) => x.name)).toEqual([
    'coreyhaines31/marketingskills',
  ]);

  await markAsSeen([a.id], db); // idempotente
  await markAsSeen([], db);
  expect(await dedupeCandidates([], db)).toEqual([]);
});
