import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { collectAntigravity } from '../batch/antigravity.js';
import { collectBatch } from '../batch/collect.js';
import { crossWeek } from '../cross/cross.js';
import { closeDatabases } from '../db/index.js';
import { writeCandidatesFile } from '../pipeline/candidates-file.js';
import { publishWeek } from '../publish/publish.js';
import {
  catalog,
  interestsYaml,
  readFixture,
  realScorings,
  realWeekFile,
} from '../testing/real-data.js';
import { editCatalogRow } from '../vault/catalogo-edit.js';
import { parseCatalog } from '../vault/catalogo.js';
import { formatStatus, weekStatus } from './status.js';

const WEEK = '2026-W40';
const file = realWeekFile();
const claude = realScorings(file);
const AG = [5, 8, 7, 9, 8, 5, 5, 4, 3, 3, 2, 2, 8];
const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00Z`);

let repoDir: string;
let vaultDir: string;
const status = () => weekStatus({ repoDir, vaultDir, week: WEEK });
const step = async (name: string) => {
  const s = (await status()).steps.find((x) => x.name === name);
  if (!s) throw new Error(`no hay paso ${name}`);
  return s;
};
const writeScoring = (name: string, agent: string, scores: number[]) => {
  const dir = path.join(repoDir, 'data', 'batches', WEEK);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    JSON.stringify(claude.map((s, i) => ({ ...s, agent, score: scores[i] }))),
  );
};

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-status-repo-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-status-vault-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), interestsYaml);
  fs.writeFileSync(path.join(repoDir, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(
    path.join(vaultDir, 'Catalogo.md'),
    readFixture('vault/Catalogo.md'),
  );
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

test('sin recogida: no hay nada que evaluar (el reintento no tiene nada que hacer)', async () => {
  const s = await status();

  expect(s).toMatchObject({
    week: WEEK,
    complete: false,
    nothingToEvaluate: true,
  });
  expect(s.steps.map((x) => x.done)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(s.steps[0].detail).toContain('la recogida no se ha hecho');
});

test('recorre el flujo real paso a paso: cada paso se marca solo cuando de verdad ocurre', async () => {
  // recogida hecha, Claude Code ha escrito su scoring pero no se ha validado
  await writeCandidatesFile(repoDir, file);
  writeScoring(
    'scoring.json',
    'claude-code',
    claude.map((s) => s.score),
  );
  let s = await status();
  expect(s.nothingToEvaluate).toBe(false);
  expect((await step('recogida')).detail).toBe(
    '13 fichas en data/candidates/2026-W40.json',
  );
  expect((await step('evaluación de Claude Code')).done).toBe(false);
  expect((await step('evaluación de Claude Code')).detail).toContain(
    'no se ha validado con collect-batch',
  );

  // collect-batch valida y guarda
  await collectBatch({ repoDir, week: WEEK });
  expect((await step('evaluación de Claude Code')).detail).toBe(
    '13 scorings validados',
  );
  expect((await step('evaluación de Antigravity')).detail).toBe('pendiente');

  // Antigravity: un fallo anotado cuenta como resuelto (no se reintenta)
  const failed = await collectAntigravity({
    repoDir,
    week: WEEK,
    reason: 'agy agotó el tiempo',
  });
  expect(failed.ok).toBe(false);
  const agy = await step('evaluación de Antigravity');
  expect(agy.done).toBe(true);
  expect(agy.detail).toContain('falló y está anotada (agy agotó el tiempo)');

  // cruce solo con Claude Code (Antigravity falló)
  await crossWeek({ repoDir, week: WEEK, now: at('10:00') });
  expect((await step('cruce')).detail).toBe('cruce.json con claude-code');
  expect((await step('publicación')).done).toBe(false);

  // publicado: queda revisar los candidato
  await publishWeek({ repoDir, vaultDir, week: WEEK, now: at('10:05') });
  expect((await step('publicación')).done).toBe(true);
  const review = await step('revisión de hallazgos');
  expect(review.done).toBe(false);
  expect(review.detail).toContain('5 en candidato sin revisar');
  s = await status();
  expect(s.complete).toBe(false);
  expect(formatStatus(s)[0]).toBe('Semana 2026-W40: sin cerrar');
  expect(formatStatus(s)).toContain(
    '  ✓ evaluación de Claude Code — 13 scorings validados',
  );
});

test('con todo hecho y los candidato revisados, la semana está cerrada', async () => {
  await writeCandidatesFile(repoDir, file);
  writeScoring(
    'scoring.json',
    'claude-code',
    claude.map((s) => s.score),
  );
  writeScoring('scoring-antigravity.json', 'antigravity', AG);
  await collectBatch({ repoDir, week: WEEK });
  expect((await collectAntigravity({ repoDir, week: WEEK })).ok).toBe(true);
  await crossWeek({ repoDir, week: WEEK, now: at('10:00') });
  await publishWeek({ repoDir, vaultDir, week: WEEK, now: at('10:05') });

  // la revisión escribe estados sobre cada fila `candidato` de la semana
  const catalogFile = path.join(vaultDir, 'Catalogo.md');
  let text = fs.readFileSync(catalogFile, 'utf8');
  for (const row of parseCatalog(text).filter(
    (e) => e.estado === 'candidato' && e.semana === WEEK,
  )) {
    text = editCatalogRow(
      text,
      row.repo as string,
      { estado: 'probado' },
      '2026-10-01',
    ).text;
  }
  fs.writeFileSync(catalogFile, text);

  const s = await status();

  expect(s.complete).toBe(true);
  expect(s.steps.every((x) => x.done)).toBe(true);
  expect((await step('evaluación de Antigravity')).detail).toBe(
    '13 scorings validados',
  );
  expect((await step('cruce')).detail).toBe(
    'cruce.json con claude-code + antigravity',
  );
  expect(formatStatus(s)[0]).toBe('Semana 2026-W40: cerrada');
});

test('un informe publicado antes del cruce está desfasado: hay que volver a publicar', async () => {
  await writeCandidatesFile(repoDir, file);
  writeScoring(
    'scoring.json',
    'claude-code',
    claude.map((s) => s.score),
  );
  writeScoring('scoring-antigravity.json', 'antigravity', AG);
  await collectBatch({ repoDir, week: WEEK });
  await collectAntigravity({ repoDir, week: WEEK });
  await publishWeek({ repoDir, vaultDir, week: WEEK, now: at('09:00') });
  await crossWeek({ repoDir, week: WEEK, now: at('10:00') });

  const publication = await step('publicación');

  expect(publication.done).toBe(false);
  expect(publication.detail).toBe(
    'el informe es anterior al cruce (hay que volver a publicar)',
  );
});

test('cada paso lleva un id estable (lo usa run-weekly.ps1, que es ASCII y no compara nombres con tildes)', async () => {
  const s = await status();

  expect(s.steps.map((x) => x.id)).toEqual([
    'recogida',
    'claude',
    'antigravity',
    'cruce',
    'publicacion',
    'revision',
  ]);
  // el JSON que imprime `spf status --json` es el mismo objeto
  expect(JSON.parse(JSON.stringify(s))).toMatchObject({
    week: WEEK,
    complete: false,
    nothingToEvaluate: true,
  });
});

test('los tres estados que distingue el flujo semanal: sin recogida, con recogida sin evaluar, evaluada', async () => {
  // 1. sin recogida
  const none = await status();
  expect([none.nothingToEvaluate, none.complete]).toEqual([true, false]);

  // 2. con recogida, sin evaluar
  await writeCandidatesFile(repoDir, file);
  const collected = await status();
  expect([collected.nothingToEvaluate, collected.complete]).toEqual([
    false,
    false,
  ]);
  expect(collected.steps.filter((x) => x.done).map((x) => x.id)).toEqual([
    'recogida',
  ]);

  // 3. evaluada y revisada
  writeScoring(
    'scoring.json',
    'claude-code',
    claude.map((s) => s.score),
  );
  writeScoring('scoring-antigravity.json', 'antigravity', AG);
  await collectBatch({ repoDir, week: WEEK });
  await collectAntigravity({ repoDir, week: WEEK });
  await crossWeek({ repoDir, week: WEEK, now: at('10:00') });
  await publishWeek({ repoDir, vaultDir, week: WEEK, now: at('10:05') });
  const catalogFile = path.join(vaultDir, 'Catalogo.md');
  let text = fs.readFileSync(catalogFile, 'utf8');
  for (const row of parseCatalog(text).filter(
    (e) => e.estado === 'candidato' && e.semana === WEEK,
  )) {
    text = editCatalogRow(
      text,
      row.repo as string,
      { estado: 'probado' },
      '2026-10-01',
    ).text;
  }
  fs.writeFileSync(catalogFile, text);
  const done = await status();
  expect([done.nothingToEvaluate, done.complete]).toEqual([false, true]);
});
