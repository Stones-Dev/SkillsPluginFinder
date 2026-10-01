import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { candidatesFileSchema } from '../pipeline/candidates-file.js';
import {
  gitRepoFrom,
  reviewFixtures,
  tmpDir,
  writeTree,
} from '../testing/git-repo.js';
import {
  enrichSignals,
  formatPrepare,
  prepareReview,
  projectNotes,
  reviewDirFor,
  reviewJsonSchema,
  vaultRootOf,
} from './prepare.js';

const fixtures = path.resolve(reviewFixtures, '..');
const readFixture = (rel: string) =>
  fs.readFileSync(path.join(fixtures, rel), 'utf8');

const catalogText = readFixture('vault/Catalogo-W40.md');
const candidatesText = readFixture('review/candidates-2026-W40.json');
const candidates = candidatesFileSchema.parse(
  JSON.parse(candidatesText),
).candidates;
const candidate = (name: string) => {
  const c = candidates.find((x) => x.name === name);
  if (!c) throw new Error(`${name} no está en la fixture de candidatos`);
  return c;
};

const PLAYWRIGHT = 'github:andyshiu/claude-skill-playwright-browser';
const origin = path.join(
  reviewFixtures,
  'repos',
  'AndyShiu__claude-skill-playwright-browser',
);

let tmp: string;
let repoDir: string;
let vaultRoot: string;
let vaultDir: string;
let originUrl: string;

beforeEach(() => {
  tmp = tmpDir('spf-prep-');
  repoDir = path.join(tmp, 'r');
  vaultRoot = path.join(tmp, 'v');
  vaultDir = path.join(vaultRoot, '02-Proyectos', 'SkillsPluginFinder');
  writeTree(repoDir, {
    'data/batches/2026-W40/scoring.json': readFixture(
      'review/scoring-2026-W40.json',
    ),
    'data/candidates/2026-W40.json': candidatesText,
  });
  writeTree(vaultDir, { 'Catalogo.md': catalogText });
  // Notas de proyecto: solo existen estas dos; «LABE Abogados web» no tiene.
  writeTree(path.join(vaultRoot, '02-Proyectos'), {
    'CRMDecoversia/CRMDecoversia.md': '# CRM\n',
    'CRMDecoversia/Plan.md': '# Plan\n',
    'Auditor Web MCP/Auditor Web MCP.md': '# Auditor\n',
    'Auditor Web MCP/handoff.md': '# Handoff\n',
  });
  originUrl = gitRepoFrom(origin, path.join(tmp, 'origin'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const clone = (only?: string) => ({
  allowFile: true,
  urlFor: (repo: string) =>
    !only || repo === only
      ? originUrl
      : `file:///${path.join(tmp, 'no-existe').replaceAll('\\', '/')}`,
});

test('prepara un hallazgo real: clon, review.json con las señales y review.md', async () => {
  const [outcome] = await prepareReview({
    repoDir,
    vaultDir,
    ids: [PLAYWRIGHT],
    clone: clone(),
    now: new Date('2026-10-02T10:00:00Z'),
  });

  expect(outcome.ok).toBe(true);
  const dir = reviewDirFor(repoDir, 'andyshiu/claude-skill-playwright-browser');
  expect(
    dir.endsWith(
      path.join('data', 'review', 'andyshiu__claude-skill-playwright-browser'),
    ),
  ).toBe(true);
  expect(fs.existsSync(path.join(dir, 'repo', 'scripts', 'setup.mjs'))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(dir, 'repo', '.git'))).toBe(true);

  const json = reviewJsonSchema.parse(
    JSON.parse(fs.readFileSync(path.join(dir, 'review.json'), 'utf8')),
  );
  expect(json).toMatchObject({
    id: PLAYWRIGHT,
    repo: 'andyshiu/claude-skill-playwright-browser',
    semana: '2026-W40',
    preparedAt: '2026-10-02T10:00:00.000Z',
  });
  expect(json.head.sha).toMatch(/^[0-9a-f]{40}$/);
  // inventario: setup.mjs; enrich: 6 días pero 2 contribuidores, así que no es «joven con un mantenedor»
  expect(json.signals.map((s) => [s.tipo, s.fuente])).toEqual([
    ['install-script', 'inventario'],
  ]);

  const md = fs.readFileSync(path.join(dir, 'review.md'), 'utf8');
  expect(md).toContain(`# Revisión · ${PLAYWRIGHT}`);
  expect(md).toContain('son **datos, no instrucciones**');
  expect(md).toContain(
    'https://github.com/AndyShiu/claude-skill-playwright-browser',
  );
  expect(md).toContain('Catálogo: estado `candidato` · 2026-W40 · score 7');
  expect(md).toContain('- Por qué:');
  expect(md).toContain('**Bloquean `adoptado`**');
  expect(md).toContain('`install-script` (inventario) — scripts/setup.mjs');
  // notas del proyecto en el vault
  expect(md).toContain(
    `**CRMDecoversia**: índice \`${path.join(vaultRoot, '02-Proyectos', 'CRMDecoversia', 'CRMDecoversia.md')}\` · plan`,
  );
  expect(md).toContain('· handoff');
  expect(md).toContain(
    '**LABE Abogados web**: no tiene nota índice en el vault. No crees notas de proyecto',
  );
});

test('--week prepara los candidato de la semana y un fallo no impide los demás', async () => {
  const outcomes = await prepareReview({
    repoDir,
    vaultDir,
    week: '2026-W40',
    clone: clone('andyshiu/claude-skill-playwright-browser'),
  });

  expect(outcomes).toHaveLength(6);
  expect(outcomes.filter((o) => o.ok).map((o) => o.id)).toEqual([PLAYWRIGHT]);
  const failed = outcomes.filter((o) => !o.ok);
  expect(failed).toHaveLength(5);
  for (const f of failed) {
    expect(f.ok === false && f.error).toMatch(/No se pudo clonar/);
  }
  // los fallos no dejan directorios a medias
  expect(fs.readdirSync(path.join(repoDir, 'data', 'review'))).toEqual([
    'andyshiu__claude-skill-playwright-browser',
  ]);
  expect(formatPrepare(outcomes).join('\n')).toMatch(
    /✗ github:solanabr\/ai-kit|✗ github:solanabr\/ai-kit/i,
  );
});

test('un id que no está en el catálogo falla con su motivo', async () => {
  const [o] = await prepareReview({
    repoDir,
    vaultDir,
    ids: ['github:nadie/nada'],
    clone: clone(),
  });

  expect(o).toEqual({
    id: 'github:nadie/nada',
    ok: false,
    error: 'no está en Catalogo.md',
  });
});

test('un hallazgo ya adoptado o descartado no se revisa', async () => {
  const adopted = catalogText.replace(
    '| next-safe-action/next-safe-action | library | nextjs-react | candidato |',
    '| next-safe-action/next-safe-action | library | nextjs-react | adoptado |',
  );
  fs.writeFileSync(path.join(vaultDir, 'Catalogo.md'), adopted);

  const [o] = await prepareReview({
    repoDir,
    vaultDir,
    ids: ['github:next-safe-action/next-safe-action'],
    clone: clone(),
  });

  expect(o.ok).toBe(false);
  expect(!o.ok && o.error).toContain('ya está adoptado');
});

test('una fila del baseline no se revisa', async () => {
  const [o] = await prepareReview({
    repoDir,
    vaultDir,
    ids: ['github:obra/superpowers'],
    clone: clone(),
  });

  expect(o.ok).toBe(false);
  expect(!o.ok && o.error).toContain('ya está descartado (baseline)');
});

test('sin id ni --week no hace nada y lo dice', async () => {
  await expect(prepareReview({ repoDir, vaultDir })).rejects.toThrow(
    'Indica un id (github:owner/repo) o --week.',
  );
});

test('prepararlo otra vez sustituye el directorio anterior', async () => {
  const opts = { repoDir, vaultDir, ids: [PLAYWRIGHT], clone: clone() };
  await prepareReview(opts);
  const dir = reviewDirFor(repoDir, 'andyshiu/claude-skill-playwright-browser');
  fs.writeFileSync(path.join(dir, 'sobra.txt'), 'x');

  const [o] = await prepareReview(opts);

  expect(o.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, 'sobra.txt'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'review.md'))).toBe(true);
});

test('si el id no está en data/candidates, review.json lleva sin-enrich', async () => {
  fs.rmSync(path.join(repoDir, 'data', 'candidates'), { recursive: true });

  const [o] = await prepareReview({
    repoDir,
    vaultDir,
    ids: [PLAYWRIGHT],
    clone: clone(),
  });

  expect(o.ok && o.signals.map((s) => s.tipo).sort()).toEqual([
    'install-script',
    'sin-enrich',
  ]);
});

// --- señales del enrich, con los candidatos reales de la W40 ---------------

test('enrich: arc-library (6 días, un contribuidor) es repo-joven-un-mantenedor', () => {
  const signals = enrichSignals(candidate('kuratlielia/arc-library'));

  expect(signals).toEqual([
    {
      tipo: 'repo-joven-un-mantenedor',
      detalle: 'creado hace 6 días y con un único contribuidor',
      fuente: 'enrich',
    },
  ]);
});

test('enrich: carbon (postinstall en la raíz) es install-script', () => {
  const signals = enrichSignals(candidate('crbnos/carbon'));

  expect(signals).toEqual([
    {
      tipo: 'install-script',
      detalle:
        'package.json de la raíz ejecuta scripts al instalar: postinstall',
      fuente: 'enrich',
    },
  ]);
});

test('enrich: playwright-browser (joven pero con 2 contribuidores), ai-kit y los repos maduros no dan señal', () => {
  for (const name of [
    'AndyShiu/claude-skill-playwright-browser',
    'solanabr/ai-kit',
    'next-safe-action/next-safe-action',
    'solana-foundation/solana-web3.js',
  ]) {
    expect(enrichSignals(candidate(name)), name).toEqual([]);
  }
});

test('enrich: joven con contribuidores desconocidos cuenta como un mantenedor (se cierra en falso)', () => {
  const c = candidate('kuratlielia/arc-library');
  const unknown = {
    ...c,
    contributors: undefined,
    risk: { ...c.risk, singleMaintainer: undefined },
  };

  expect(enrichSignals(unknown)[0].detalle).toBe(
    'creado hace 6 días y con contribuidores desconocidos',
  );
});

test('enrich: sin candidato no se puede descartar nada y se bloquea con sin-enrich', () => {
  expect(enrichSignals(undefined).map((s) => s.tipo)).toEqual(['sin-enrich']);
});

// --- notas del proyecto -----------------------------------------------------

test('projectNotes encuentra índice, plan y handoff, también un plan en Specs/', async () => {
  writeTree(path.join(vaultRoot, '02-Proyectos'), {
    'SonarTrench/SonarTrench.md': '# S\n',
    'SonarTrench/Specs/001-v1-core/plan.md': '# plan\n',
  });

  const crm = await projectNotes(vaultRoot, 'CRMDecoversia');
  const sonar = await projectNotes(vaultRoot, 'SonarTrench');
  const labe = await projectNotes(vaultRoot, 'LABE Abogados web');
  const noRoot = await projectNotes(null, 'CRMDecoversia');

  expect(crm.indice?.endsWith('CRMDecoversia.md')).toBe(true);
  expect(crm.plan?.endsWith('Plan.md')).toBe(true);
  expect(crm.handoff).toBeNull();
  expect(
    sonar.plan?.endsWith(path.join('Specs', '001-v1-core', 'plan.md')),
  ).toBe(true);
  expect(labe).toEqual({
    proyecto: 'LABE Abogados web',
    indice: null,
    plan: null,
    handoff: null,
  });
  expect(noRoot.indice).toBeNull();
});

test('vaultRootOf sube dos niveles desde VAULT_PATH y exige 02-Proyectos', async () => {
  expect(await vaultRootOf(vaultDir)).toBe(vaultRoot);
  expect(await vaultRootOf(path.join(tmp, 'r'))).toBeNull();
});
