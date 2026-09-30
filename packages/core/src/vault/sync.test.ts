import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { extractYamlBlock, normalizeYaml } from './markdown.js';
import { lineDiff, syncInterests } from './sync.js';

const fixtures = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/vault',
);
const fixture = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8').replace(/\r\n/g, '\n');

const NOW = new Date('2026-10-01T10:00:00Z');
const LATER = new Date('2026-10-02T10:00:00Z');

let vaultDir: string;
let repoDir: string;
const vaultFile = (n: string) => path.join(vaultDir, n);
const repoFile = (n: string) => path.join(repoDir, n);
const run = (now = NOW) => syncInterests({ vaultDir, repoDir, now });

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-vault-'));
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-repo-'));
  fs.writeFileSync(vaultFile('Intereses.md'), fixture('Intereses.md'));
  fs.writeFileSync(vaultFile('Catalogo.md'), fixture('Catalogo.md'));
});
afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('primera ejecución: gana el vault y crea los tres espejos', async () => {
  const result = await run();

  expect(result).toEqual({
    interests: 'created',
    catalogEntries: 9,
    catalogChanged: true,
  });
  expect(fs.readFileSync(repoFile('interests.yaml'), 'utf8')).toBe(
    normalizeYaml(extractYamlBlock(fixture('Intereses.md')).body),
  );
  expect(
    JSON.parse(fs.readFileSync(repoFile('catalog.json'), 'utf8')),
  ).toHaveLength(9);
  const state = JSON.parse(
    fs.readFileSync(repoFile('data/sync-state.json'), 'utf8'),
  );
  expect(state.syncedAt).toBe(NOW.toISOString());
});

test('segunda ejecución sin cambios: no reescribe nada, ni el estado', async () => {
  await run();
  const state = fs.readFileSync(repoFile('data/sync-state.json'), 'utf8');

  expect(await run(LATER)).toEqual({
    interests: 'unchanged',
    catalogEntries: 9,
    catalogChanged: false,
  });
  expect(fs.readFileSync(repoFile('data/sync-state.json'), 'utf8')).toBe(state);
});

test('solo cambia el vault: actualiza interests.yaml conservando comentarios', async () => {
  await run();
  fs.writeFileSync(
    vaultFile('Intereses.md'),
    fixture('Intereses.md').replace('umbral_score: 7', 'umbral_score: 8'),
  );

  expect((await run(LATER)).interests).toBe('vault-to-repo');
  const yaml = fs.readFileSync(repoFile('interests.yaml'), 'utf8');
  expect(yaml).toContain('umbral_score: 8');
  expect(yaml).toContain('# mínimo para publicar');
});

test('solo cambia el repo: reescribe el bloque del vault sin tocar el resto y sube updated', async () => {
  await run();
  const yamlPath = repoFile('interests.yaml');
  fs.writeFileSync(
    yamlPath,
    fs
      .readFileSync(yamlPath, 'utf8')
      .replace('umbral_score: 7', 'umbral_score: 9'),
  );

  expect((await run(LATER)).interests).toBe('repo-to-vault');
  expect(fs.readFileSync(vaultFile('Intereses.md'), 'utf8')).toBe(
    fixture('Intereses.md')
      .replace('umbral_score: 7', 'umbral_score: 9')
      .replace('updated: 2026-09-29', 'updated: 2026-10-02'),
  );
  expect(fs.readdirSync(vaultDir).sort()).toEqual([
    'Catalogo.md',
    'Intereses.md',
  ]);
});

test('cambian ambos lados: aborta con diff y no modifica nada', async () => {
  await run();
  const vaultMd = fixture('Intereses.md').replace(
    'umbral_score: 7',
    'umbral_score: 8',
  );
  fs.writeFileSync(vaultFile('Intereses.md'), vaultMd);
  const yamlPath = repoFile('interests.yaml');
  const repoYaml = fs
    .readFileSync(yamlPath, 'utf8')
    .replace('umbral_score: 7', 'umbral_score: 9');
  fs.writeFileSync(yamlPath, repoYaml);

  const failure = run(LATER);
  await expect(failure).rejects.toThrow('ambos lados');
  await expect(failure).rejects.toThrow(/- umbral_score: 8/);
  await expect(failure).rejects.toThrow(/\+ umbral_score: 9/);
  expect(fs.readFileSync(vaultFile('Intereses.md'), 'utf8')).toBe(vaultMd);
  expect(fs.readFileSync(yamlPath, 'utf8')).toBe(repoYaml);
});

test('el vault con YAML inválido aborta sin escribir nada', async () => {
  fs.writeFileSync(
    vaultFile('Intereses.md'),
    fixture('Intereses.md').replace('version: 1', 'version: [sin cerrar'),
  );

  await expect(run()).rejects.toThrow('Intereses.md inválido');
  expect(fs.readdirSync(repoDir)).toEqual([]);
});

test('interests.yaml distinto y sin estado previo: aborta, no adivina', async () => {
  fs.writeFileSync(
    repoFile('interests.yaml'),
    extractYamlBlock(fixture('Intereses.md')).body.replace(
      'umbral_score: 7',
      'umbral_score: 9',
    ),
  );

  await expect(run()).rejects.toThrow('sync-state.json');
  expect(fs.existsSync(repoFile('data/sync-state.json'))).toBe(false);
});

test('interests.yaml igual y sin estado previo: solo registra el estado', async () => {
  fs.writeFileSync(
    repoFile('interests.yaml'),
    extractYamlBlock(fixture('Intereses.md')).body,
  );

  expect((await run()).interests).toBe('unchanged');
  expect(fs.existsSync(repoFile('data/sync-state.json'))).toBe(true);
});

test('cambiar un estado en Catalogo.md se exporta a catalog.json', async () => {
  await run();
  fs.writeFileSync(
    vaultFile('Catalogo.md'),
    fixture('Catalogo.md').replace(
      '| Spec Kit | tool | claude-skills | adoptado',
      '| Spec Kit | tool | claude-skills | descartado',
    ),
  );

  expect((await run(LATER)).catalogChanged).toBe(true);
  const catalog = JSON.parse(fs.readFileSync(repoFile('catalog.json'), 'utf8'));
  expect(
    catalog.find((e: { nombre: string }) => e.nombre === 'Spec Kit').estado,
  ).toBe('descartado');
});

test('lineDiff muestra solo las líneas que difieren', () => {
  expect(lineDiff('a\nb\nc\n', 'a\nx\nc\n', 'A', 'B')).toBe(
    '--- A\n+++ B\n- b\n+ x',
  );
});
