import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { parseCatalog } from '../vault/catalogo.js';
import { extractYamlBlock } from '../vault/markdown.js';
import { loadCatalog, loadInterests, parseInterestsYaml } from './interests.js';

const fixtures = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/vault',
);
const read = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8').replace(/\r\n/g, '\n');

const realYaml = extractYamlBlock(read('Intereses.md')).body;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-config-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parsea la nota real Intereses.md: parámetros, categorías y exclusiones', () => {
  const i = parseInterestsYaml(realYaml, 'Intereses.md');

  expect(i.umbral_score).toBe(7);
  expect(i.enrich_max).toBe(80);
  expect(i.ventana_dias).toBe(14);
  expect(i.reglas_globales.licencias_ok).toEqual([
    'MIT',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'ISC',
    'MPL-2.0',
    'Unlicense',
  ]);
  expect(Object.keys(i.categorias)).toEqual([
    'claude-skills',
    'mcp-servers',
    'agent-skills',
    'nextjs-react',
    'frontend-bonito',
    'rust',
    'solana',
    'dotnet',
    'sage200',
    'librerias-relacionadas',
  ]);
  expect(i.categorias['claude-skills'].estrellas_min).toBe(20);
  expect(i.categorias.rust.estrellas_min).toBeUndefined();
  expect(i.categorias.sage200.contexto).toContain('[[Sage 200 MCP]]');
  expect(i.excluir).toEqual([
    'obra/superpowers',
    'garrytan/gstack',
    'thedotmack/claude-mem',
    'anthropics/skills',
    '*/awesome-*',
  ]);
});

test('proyectos son strings literales, también la línea que YAML lee como mapa', () => {
  const { proyectos } = parseInterestsYaml(realYaml, 'Intereses.md');

  expect(proyectos).toHaveLength(11);
  expect(proyectos.every((p) => typeof p === 'string')).toBe(true);
  // "Solana: Yellowstone" hace que YAML lea esta línea como un mapa de un par.
  expect(proyectos[2]).toBe(
    'SonarTrench — bot de alertas memecoins Solana: Yellowstone gRPC, Rust/TS, Discord, web Next.js 15 con login wallet',
  );
  expect(proyectos.some((p) => p.includes('{"'))).toBe(false);
  expect(proyectos[6]).toMatch(/^Sage 200 MCP — /);
});

test('rechaza claves desconocidas, valores fuera de rango y YAML roto', () => {
  expect(() => parseInterestsYaml('umbral_scor: 5\n')).toThrow('umbral_scor');
  expect(() =>
    parseInterestsYaml('categorias:\n  x:\n    nombre: X\n    peso: 2\n'),
  ).toThrow('categorias.x.peso');
  expect(() => parseInterestsYaml('a: [sin cerrar\n', 'Intereses.md')).toThrow(
    'Intereses.md inválido',
  );
  expect(() => parseInterestsYaml('')).toThrow('no cumple el esquema');
});

test('un proyecto estructurado (no una línea de texto) se rechaza señalando su posición', () => {
  expect(() =>
    parseInterestsYaml('proyectos:\n  - nombre: A\n    stack: B\n'),
  ).toThrow('proyectos.0');
});

test('loadInterests lee el espejo del repo y avisa si falta', async () => {
  await expect(loadInterests(tmp)).rejects.toThrow('interests sync');
  fs.writeFileSync(path.join(tmp, 'interests.yaml'), realYaml);
  expect((await loadInterests(tmp)).proyectos).toHaveLength(11);
});

test('loadCatalog lee catalog.json y valida el esquema', async () => {
  await expect(loadCatalog(tmp)).rejects.toThrow('interests sync');

  const entries = parseCatalog(read('Catalogo.md'));
  fs.writeFileSync(path.join(tmp, 'catalog.json'), JSON.stringify(entries));
  expect(await loadCatalog(tmp)).toEqual(entries);

  fs.writeFileSync(path.join(tmp, 'catalog.json'), '{no es json');
  await expect(loadCatalog(tmp)).rejects.toThrow('no es JSON válido');

  fs.writeFileSync(
    path.join(tmp, 'catalog.json'),
    JSON.stringify([{ ...entries[0], estado: 'quizás' }]),
  );
  await expect(loadCatalog(tmp)).rejects.toThrow('no cumple el esquema');
});
