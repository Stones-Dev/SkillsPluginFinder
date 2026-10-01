import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BatchRejectedError } from '../batch/collect.js';
import { closeDatabases, getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { filterCandidates } from '../filter/index.js';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import {
  NOW,
  catalog,
  interests,
  interestsYaml,
  readFixture,
  realCandidates,
  realScorings,
  realWeekFile,
  scoreFor,
} from '../testing/real-data.js';
import { parseCatalog } from '../vault/catalogo.js';
import { publishWeek } from './publish.js';

const MOCK_REPORT = '# Informe 2026-W40\n\nSe evaluaron 1 candidatos.\n';

let repoDir: string;
let vaultDir: string;
const report = () => path.join(vaultDir, 'Informes', '2026-W40.md');
const catalogFile = () => path.join(vaultDir, 'Catalogo.md');
const publish = (over: Partial<Parameters<typeof publishWeek>[0]> = {}) =>
  publishWeek({ repoDir, vaultDir, week: '2026-W40', now: NOW, ...over });

async function seedWeek(
  week: string,
  file = realWeekFile(),
  scorings = realScorings(file),
) {
  await writeCandidatesFile(repoDir, { ...file, week });
  const dir = path.join(repoDir, 'data', 'batches', week);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scoring.json'),
    JSON.stringify(scorings.map((s) => ({ ...s, week }))),
  );
}

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-pub-repo-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-pub-vault-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), interestsYaml);
  fs.writeFileSync(path.join(repoDir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(catalogFile(), readFixture('vault/Catalogo.md'));
  await seedWeek('2026-W40');
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

test('publica el informe y las filas del catálogo, y sobrescribe el informe basura del mock', async () => {
  fs.mkdirSync(path.dirname(report()));
  fs.writeFileSync(report(), MOCK_REPORT);

  const summary = await publish();

  expect(summary).toEqual({
    reportFile: report(),
    evaluated: 13,
    published: 5,
    catalogAdded: 5,
    catalogSkipped: 0,
    catalogUpdated: 0,
  });
  const md = fs.readFileSync(report(), 'utf8');
  expect(md).not.toContain('Se evaluaron 1 candidatos');
  expect(matter(md).data).toMatchObject({
    type: 'log',
    status: 'draft',
    revisado: false,
    semana: '2026-W40',
    agente: 'claude-code',
  });
  expect(md).toContain('**5 hallazgos** con score ≥ 7 de **13** evaluados');

  const entries = parseCatalog(fs.readFileSync(catalogFile(), 'utf8'));
  expect(entries).toHaveLength(catalog.length + 5);
  expect(entries.slice(0, catalog.length)).toEqual(catalog);
  const added = entries.slice(catalog.length);
  expect(
    added.every(
      (e) =>
        e.estado === 'candidato' &&
        e.semana === '2026-W40' &&
        e.score !== null &&
        e.score >= 7,
    ),
  ).toBe(true);
  expect(added.map((e) => e.score)).toEqual([9, 8, 8, 7, 7]);
  expect(added.find((e) => e.nombre === 'alsk1992/CloddsBot')).toMatchObject({
    categoria: 'solana',
    tipo: 'library', // su descripción no menciona plugins, skills ni MCP
    enlace: 'https://github.com/alsk1992/CloddsBot',
  });
  expect(added[0].nota).toContain('[[2026-W40]]');
});

test('deja el vault limpio: solo el informe y el catálogo, sin temporales', async () => {
  await publish();

  expect(fs.readdirSync(vaultDir).sort()).toEqual(['Catalogo.md', 'Informes']);
  expect(fs.readdirSync(path.join(vaultDir, 'Informes'))).toEqual([
    '2026-W40.md',
  ]);
});

test('registra la ejecución de la mitad local', async () => {
  await publish();
  const rows = getDb(path.join(repoDir, 'data', 'seen.sqlite'))
    .select()
    .from(runs)
    .all();

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    half: 'evaluate',
    week: '2026-W40',
    trigger: 'manual',
  });
  expect(rows[0].stats).toEqual({
    scored: 13,
    published: 5,
    catalogAdded: 5,
    catalogSkipped: 0,
    catalogUpdated: 0,
  });
});

test('es idempotente: publicar dos veces no duplica filas ni cambia el informe', async () => {
  await publish();
  const firstReport = fs.readFileSync(report(), 'utf8');
  const firstCatalog = fs.readFileSync(catalogFile(), 'utf8');

  const again = await publish();

  expect(again).toMatchObject({
    published: 5,
    catalogAdded: 0,
    catalogSkipped: 5,
  });
  expect(fs.readFileSync(report(), 'utf8')).toBe(firstReport);
  expect(fs.readFileSync(catalogFile(), 'utf8')).toBe(firstCatalog);
});

test('al republicar otro día conserva created y actualiza updated', async () => {
  await publish();
  await publish({ now: new Date('2026-10-02T09:00:00Z') });

  const { data } = matter(fs.readFileSync(report(), 'utf8'));
  expect(new Date(data.created).toISOString().slice(0, 10)).toBe('2026-09-30');
  expect(new Date(data.updated).toISOString().slice(0, 10)).toBe('2026-10-02');
});

test('un informe ya revisado no se sobrescribe sin --force', async () => {
  await publish();
  const reviewed = fs
    .readFileSync(report(), 'utf8')
    .replace('revisado: false', 'revisado: true');
  fs.writeFileSync(report(), reviewed);

  await expect(publish()).rejects.toThrow('ya está revisado (revisado: true)');
  expect(fs.readFileSync(report(), 'utf8')).toBe(reviewed);

  await publish({ force: true });
  expect(matter(fs.readFileSync(report(), 'utf8')).data.revisado).toBe(false);
});

test('un cambio de estado hecho a mano en el catálogo sobrevive a las publicaciones siguientes', async () => {
  await publish();
  const text = fs.readFileSync(catalogFile(), 'utf8');
  const [firstFinding] = parseCatalog(text).slice(catalog.length);
  fs.writeFileSync(
    catalogFile(),
    text.replace(
      `| ${firstFinding.nombre} | ${firstFinding.tipo} | ${firstFinding.categoria} | candidato |`,
      `| ${firstFinding.nombre} | ${firstFinding.tipo} | ${firstFinding.categoria} | adoptado |`,
    ),
  );

  // Semana 2: otros repos reales (los que no cupieron en el tope de la semana 1).
  const week1 = new Set(realWeekFile().candidates.map((c) => c.id));
  const rest = filterCandidates(
    realCandidates(),
    interests,
    catalog,
    NOW,
  ).kept.filter((c) => !week1.has(c.id));
  expect(rest.length).toBeGreaterThan(0);
  const file2 = {
    ...realWeekFile(),
    candidates: rest,
    descartados: [],
    diferidos: [],
  };
  await seedWeek(
    '2026-W41',
    file2,
    rest.map((c, i) =>
      scoreFor(c, { score: [8, 7, 5, 4][i] ?? 3 }, '2026-W41'),
    ),
  );

  await publishWeek({
    repoDir,
    vaultDir,
    week: '2026-W41',
    now: new Date('2026-10-07T09:00:00Z'),
  });

  const entries = parseCatalog(fs.readFileSync(catalogFile(), 'utf8'));
  expect(entries.find((e) => e.nombre === firstFinding.nombre)?.estado).toBe(
    'adoptado',
  );
  expect(
    entries.filter((e) => e.estado === 'candidato' && e.semana === '2026-W40'),
  ).toHaveLength(4);
  expect(entries.filter((e) => e.semana === '2026-W41')).toHaveLength(2);
  expect(entries).toHaveLength(catalog.length + 5 + 2);
});

test('un scoring inválido rechaza el batch sin escribir nada en el vault', async () => {
  fs.mkdirSync(path.dirname(report()));
  fs.writeFileSync(report(), MOCK_REPORT);
  const catalogBefore = fs.readFileSync(catalogFile(), 'utf8');
  const file = realWeekFile();
  await seedWeek(
    '2026-W40',
    file,
    realScorings(file).map((s) => ({ ...s, score: 9 })),
  ); // sesgo

  await expect(publish()).rejects.toBeInstanceOf(BatchRejectedError);
  expect(fs.readFileSync(report(), 'utf8')).toBe(MOCK_REPORT);
  expect(fs.readFileSync(catalogFile(), 'utf8')).toBe(catalogBefore);
});

test('sin Catalogo.md en el vault falla antes de escribir el informe', async () => {
  fs.rmSync(catalogFile());

  await expect(publish()).rejects.toThrow(/ENOENT/);
  expect(fs.existsSync(path.join(vaultDir, 'Informes'))).toBe(false);
});

test('una semana con formato inválido no toca el vault', async () => {
  await expect(
    publishWeek({ repoDir, vaultDir, week: '../../x', now: NOW }),
  ).rejects.toThrow('Semana inválida');
  expect(fs.readdirSync(vaultDir)).toEqual(['Catalogo.md']);
});

test('una semana sin nada relevante publica un informe válido y no añade filas', async () => {
  const file = realWeekFile();
  await seedWeek(
    '2026-W40',
    file,
    realScorings(file).map((s) => ({ ...s, score: 4 })),
  );

  const summary = await publish();

  expect(summary).toMatchObject({
    evaluated: 13,
    published: 0,
    catalogAdded: 0,
  });
  expect(fs.readFileSync(report(), 'utf8')).toContain(
    'Esta semana nada relevante',
  );
  expect(fs.readFileSync(catalogFile(), 'utf8')).toBe(
    readFixture('vault/Catalogo.md'),
  );
});
