import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { crossWeek } from '../cross/cross.js';
import { closeDatabases } from '../db/index.js';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import {
  NOW,
  catalog,
  interestsYaml,
  readFixture,
  realScorings,
  realWeekFile,
} from '../testing/real-data.js';
import { parseCatalog } from '../vault/catalogo.js';
import { publishWeek } from './publish.js';

// La semana de prueba de publish: 13 fichas reales con los scores de `realScorings`
// (9, 8, 7, 7, 6, 5, 5, 4, 3, 3, 2, 2 y CloddsBot con 8; llegan al umbral 5).
// Antigravity puntúa distinto algunas: la 0 baja de 9 a 5 (disputa), la 4 sube de 6 a 8
// (cruza el umbral) y la 3 de 7 a 9 (confianza alta, sube).
const AG = [5, 8, 7, 9, 8, 5, 5, 4, 3, 3, 2, 2, 8];

let repoDir: string;
let vaultDir: string;
const report = () => path.join(vaultDir, 'Informes', '2026-W40.md');
const catalogFile = () => path.join(vaultDir, 'Catalogo.md');
const readCatalog = () => fs.readFileSync(catalogFile(), 'utf8');
const publish = () =>
  publishWeek({ repoDir, vaultDir, week: '2026-W40', now: NOW });

const file = realWeekFile();
const claude = realScorings(file);

function writeScoring(name: string, scorings: unknown) {
  const dir = path.join(repoDir, 'data', 'batches', '2026-W40');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(scorings));
}

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-pubx-repo-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-pubx-vault-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), interestsYaml);
  fs.writeFileSync(path.join(repoDir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(catalogFile(), readFixture('vault/Catalogo.md'));
  await writeCandidatesFile(repoDir, file);
  writeScoring('scoring.json', claude);
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

const writeAntigravity = () =>
  writeScoring(
    'scoring-antigravity.json',
    claude.map((s, i) => ({ ...s, agent: 'antigravity', score: AG[i] })),
  );
const rowFor = (name: string) => {
  const row = parseCatalog(readCatalog()).find((e) => e.nombre === name);
  if (!row) throw new Error(`${name} no está en el catálogo`);
  return row;
};
const nameOf = (i: number) => file.candidates[i].name;

test('sin cruce.json publica exactamente como antes (agente claude-code, sin marcas)', async () => {
  const r = await publish();

  expect(r).toMatchObject({ published: 5, catalogAdded: 5, catalogUpdated: 0 });
  const md = fs.readFileSync(report(), 'utf8');
  expect(matter(md).data.agente).toBe('claude-code');
  expect(md).not.toContain('Evaluación cruzada');
  expect(readCatalog()).not.toContain('disputa');
});

test('con el cruce: el informe lleva el score final, las dos evaluaciones y agente mixto', async () => {
  writeAntigravity();
  await crossWeek({ repoDir, week: '2026-W40', now: NOW });

  const r = await publish();

  // CC ≥ 7: 9, 8, 7, 7, CloddsBot 8; el cruce deja 7, 8, 7, 8, 8 y suma la ficha 4 (6 → 7)
  expect(r.published).toBe(6);
  const md = fs.readFileSync(report(), 'utf8');
  expect(matter(md).data.agente).toBe('mixto');
  expect(md).toContain('**6 hallazgos** con score ≥ 7');
  expect(md).toContain(
    '**Evaluación cruzada:** Claude Code 9 · Antigravity 5 → 7 · ⚖ disputa',
  );
  expect(md).toContain(
    '**Evaluación cruzada:** Claude Code 7 · Antigravity 9 → 8 · ✓ confianza alta',
  );
  expect(md).toContain('scoring-antigravity.json` · `cruce.json`');
  // el título de cada hallazgo lleva su score final
  expect(md).toContain(`### 7 · [${nameOf(0)}]`);
  expect(md).toContain(`### 8 · [${nameOf(3)}]`);
});

test('con el cruce, las filas nuevas llevan el score final y la marca al principio de la nota', async () => {
  writeAntigravity();
  await crossWeek({ repoDir, week: '2026-W40', now: NOW });

  await publish();

  const disputed = rowFor(nameOf(0));
  expect(disputed.score).toBe(7);
  expect(disputed.nota.startsWith('⚖ disputa CC 9 · AG 5 — ')).toBe(true);
  expect(disputed.nota).toContain('[[2026-W40]]');
  const confident = rowFor(nameOf(3));
  expect(confident.score).toBe(8);
  expect(confident.nota.startsWith('✓ confianza alta CC 7 · AG 9 — ')).toBe(
    true,
  );
  // la ficha que cruza el umbral gracias a Antigravity entra como fila nueva
  expect(rowFor(nameOf(4)).score).toBe(7);
});

test('publicar sin cruce y luego cruzar: las filas candidato ya existentes se ponen al día, una sola vez', async () => {
  await publish(); // 5 filas con los scores de Claude Code
  expect(rowFor(nameOf(0)).score).toBe(9);
  const before = readCatalog();

  writeAntigravity();
  await crossWeek({ repoDir, week: '2026-W40', now: NOW });
  const r = await publish();

  expect(r).toMatchObject({
    catalogAdded: 1,
    catalogUpdated: 5,
    catalogSkipped: 5,
  });
  expect(rowFor(nameOf(0))).toMatchObject({ estado: 'candidato', score: 7 });
  expect(rowFor(nameOf(0)).nota.startsWith('⚖ disputa CC 9 · AG 5 — ')).toBe(
    true,
  );
  expect(rowFor(nameOf(3)).score).toBe(8);
  // solo cambian las filas de la semana (5 actualizadas + 1 nueva); las 9 del baseline, intactas
  const after = parseCatalog(readCatalog());
  expect(after.slice(0, catalog.length)).toEqual(catalog);
  expect(after).toHaveLength(parseCatalog(before).length + 1);

  // volver a publicar con lo mismo no cambia nada: ni filas, ni bytes del catálogo
  const again = readCatalog();
  const r2 = await publish();
  expect(r2).toMatchObject({ catalogAdded: 0, catalogUpdated: 0 });
  expect(readCatalog()).toBe(again);
});

test('una fila que ya no es candidato (probado, adoptado) no se toca al cruzar', async () => {
  await publish();
  const text = readCatalog().replace(
    new RegExp(
      `(\\| ${nameOf(0).replace('/', '\\/')} \\| [^|]+ \\| [^|]+ \\| )candidato`,
    ),
    '$1probado',
  );
  expect(text).not.toBe(readCatalog());
  fs.writeFileSync(catalogFile(), text);
  const probado = rowFor(nameOf(0));
  expect(probado.estado).toBe('probado');

  writeAntigravity();
  await crossWeek({ repoDir, week: '2026-W40', now: NOW });
  await publish();

  expect(rowFor(nameOf(0))).toEqual(probado);
});

test('un cruce.json desfasado respecto a scoring.json se rechaza en vez de publicar números viejos', async () => {
  writeAntigravity();
  await crossWeek({ repoDir, week: '2026-W40', now: NOW });
  writeScoring(
    'scoring.json',
    claude.map((s, i) => ({ ...s, score: i === 0 ? 4 : s.score })),
  );

  await expect(publish()).rejects.toThrow(
    /cruce\.json está desfasado.*spf cross/,
  );

  expect(fs.existsSync(report())).toBe(false);
});

test('un cruce con una sola fuente (Antigravity falló) publica como sin cruce', async () => {
  await crossWeek({ repoDir, week: '2026-W40', now: NOW }); // sin scoring-antigravity.json

  const r = await publish();

  expect(r).toMatchObject({ published: 5, catalogAdded: 5, catalogUpdated: 0 });
  expect(matter(fs.readFileSync(report(), 'utf8')).data.agente).toBe(
    'claude-code',
  );
});

test('un informe ya revisado no se sobrescribe aunque haya cruce, salvo con --force', async () => {
  await publish();
  fs.writeFileSync(
    report(),
    fs
      .readFileSync(report(), 'utf8')
      .replace('revisado: false', 'revisado: true'),
  );
  writeAntigravity();
  await crossWeek({ repoDir, week: '2026-W40', now: NOW });

  await expect(publish()).rejects.toThrow(/ya está revisado/);
  const forced = await publishWeek({
    repoDir,
    vaultDir,
    week: '2026-W40',
    now: NOW,
    force: true,
  });

  expect(forced.published).toBe(6);
});
