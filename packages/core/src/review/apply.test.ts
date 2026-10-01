import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { closeDatabases, getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import {
  gitRepoFrom,
  reviewFixtures,
  tmpDir,
  writeTree,
} from '../testing/git-repo.js';
import { parseCatalog } from '../vault/catalogo.js';
import {
  DISPUTA_MARK,
  applyReview,
  formatApply,
  parseReviewEstado,
} from './apply.js';
import { prepareReview, reviewDirFor, reviewJsonSchema } from './prepare.js';
import { SIGNAL_TYPES, type SignalType } from './signals.js';

const fixtures = path.resolve(reviewFixtures, '..');
const readFixture = (rel: string) =>
  fs.readFileSync(path.join(fixtures, rel), 'utf8');
const catalogText = readFixture('vault/Catalogo-W40.md');

const NSA = 'github:next-safe-action/next-safe-action';
const AIKIT = 'github:solanabr/ai-kit';
const NOW = new Date('2026-10-02T09:30:00Z'); // 2026-10-02 en Madrid
const TODAY = '2026-10-02';

let tmp: string;
let repoDir: string;
let vaultRoot: string;
let vaultDir: string;
const catalogFile = () => path.join(vaultDir, 'Catalogo.md');
const readCatalog = () => fs.readFileSync(catalogFile(), 'utf8');
const dailyFile = () => path.join(vaultRoot, '01-Diario', `${TODAY}.md`);
const rows = () => parseCatalog(readCatalog());
const rowOf = (repo: string) => {
  const r = rows().find((e) => e.repo === repo);
  if (!r) throw new Error(`${repo} no está en el catálogo`);
  return r;
};

/** Un review.json como el que deja `--prepare`, con las señales que pida el test. */
function writeReview(
  id: string,
  signals: {
    tipo: SignalType;
    detalle?: string;
    fuente?: 'inventario' | 'enrich';
  }[],
) {
  const repo = id.replace('github:', '');
  const dir = reviewDirFor(repoDir, repo);
  fs.mkdirSync(path.join(dir, 'repo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'repo', 'README.md'), 'clon\n');
  const json = reviewJsonSchema.parse({
    version: 1,
    id,
    repo,
    semana: '2026-W40',
    preparedAt: NOW.toISOString(),
    head: { sha: 'a'.repeat(40), date: '2026-10-01T00:00:00Z' },
    signals: signals.map((s) => ({
      tipo: s.tipo,
      detalle: s.detalle ?? `${s.tipo} de prueba`,
      fuente: s.fuente ?? 'inventario',
    })),
  });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(json));
  return dir;
}

const apply = (over: Partial<Parameters<typeof applyReview>[0]> = {}) =>
  applyReview({
    repoDir,
    vaultDir,
    id: NSA,
    estado: 'adoptado',
    nota: 'Encaja con SonarTrench y no instala nada.',
    now: NOW,
    ...over,
  });

beforeEach(() => {
  tmp = tmpDir('spf-apply-');
  repoDir = path.join(tmp, 'r');
  vaultRoot = path.join(tmp, 'v');
  vaultDir = path.join(vaultRoot, '02-Proyectos', 'SkillsPluginFinder');
  fs.mkdirSync(repoDir);
  writeTree(vaultDir, { 'Catalogo.md': catalogText });
  fs.mkdirSync(path.join(vaultRoot, '01-Diario'), { recursive: true });
  writeTree(vaultRoot, {
    '01-Diario/2026-10-01.md': readFixture('vault/Diario-2026-10-01.md'),
    '99-Meta/Plantillas/Plantilla Diario.md': readFixture(
      'vault/Plantilla-Diario.md',
    ),
  });
});
afterEach(() => {
  closeDatabases();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('sin señales, adoptado se escribe: solo cambia esa línea del catálogo y el updated del frontmatter', async () => {
  writeReview(NSA, []);
  const before = catalogText.split('\n');

  const r = await apply();

  expect(r).toMatchObject({
    requested: 'adoptado',
    written: 'adoptado',
    blocked: false,
  });
  expect(r.signals).toEqual([]);
  expect(r.dailyFile).toBeNull();
  expect(fs.existsSync(dailyFile())).toBe(false);

  const after = readCatalog().split('\n');
  expect(after).toHaveLength(before.length);
  const changed = after.flatMap((l, i) => (l === before[i] ? [] : [i]));
  expect(changed).toHaveLength(2); // `updated:` y la fila
  expect(after[changed[0]]).toBe(`updated: ${TODAY}`);
  const row = rowOf('next-safe-action/next-safe-action');
  expect(row.estado).toBe('adoptado');
  expect(row.nota).toContain(
    'Revisión 2026-10-02 (adoptado): Encaja con SonarTrench y no instala nada.',
  );
  expect(
    row.nota.startsWith('Server Actions de Next.js con validación zod'),
  ).toBe(true); // la nota original sigue
  // el resto de filas, tal cual (las 9 del baseline incluidas)
  const others = parseCatalog(catalogText).filter((e) => e.repo !== row.repo);
  expect(rows().filter((e) => e.repo !== row.repo)).toEqual(others);
  expect(
    parseCatalog(catalogText).filter((e) => e.semana === 'baseline'),
  ).toHaveLength(9);
});

test.each(SIGNAL_TYPES)(
  'señal %s en review.json: adoptado se rechaza, se escribe probado y se avisa en la nota diaria',
  async (tipo) => {
    writeReview(NSA, [{ tipo }]);

    const r = await apply();

    expect(r).toMatchObject({
      requested: 'adoptado',
      written: 'probado',
      blocked: true,
    });
    expect(r.signals.map((s) => s.tipo)).toEqual([tipo]);
    const row = rowOf('next-safe-action/next-safe-action');
    expect(row.estado).toBe('probado');
    expect(row.nota).toContain(
      '⛔ adoptado bloqueado por la puerta de seguridad',
    );
    expect(row.nota).toContain(tipo);
    // línea en «Bucles abiertos» de la nota diaria de hoy (creada desde la plantilla)
    expect(r.dailyCreated).toBe(true);
    const daily = fs.readFileSync(dailyFile(), 'utf8');
    expect(daily).toContain('# 2026-10-02');
    expect(daily).toContain(`\`${NSA}\` se queda en \`probado\``);
    expect(daily).toContain(tipo);
    const afterHeading = daily
      .split('## Bucles abiertos')[1]
      .split('## Notas del día')[0];
    expect(afterHeading).toContain(NSA);
  },
);

test('la señal real install-script de playwright-browser (inventario del clon) bloquea adoptado', async () => {
  const origin = gitRepoFrom(
    path.join(
      reviewFixtures,
      'repos',
      'AndyShiu__claude-skill-playwright-browser',
    ),
    path.join(tmp, 'origin'),
  );
  writeTree(repoDir, {
    'data/candidates/2026-W40.json': readFixture(
      'review/candidates-2026-W40.json',
    ),
    'data/batches/2026-W40/scoring.json': readFixture(
      'review/scoring-2026-W40.json',
    ),
  });
  const id = 'github:andyshiu/claude-skill-playwright-browser';
  const [prepared] = await prepareReview({
    repoDir,
    vaultDir,
    ids: [id],
    clone: { allowFile: true, urlFor: () => origin },
  });
  expect(prepared.ok).toBe(true);

  const r = await apply({
    id,
    nota: 'Útil, pero instala navegadores al primer uso.',
  });

  expect(r.blocked).toBe(true);
  expect(r.signals[0]).toMatchObject({
    tipo: 'install-script',
    fuente: 'inventario',
  });
  expect(rowOf('andyshiu/claude-skill-playwright-browser').estado).toBe(
    'probado',
  );
});

test.each(SIGNAL_TYPES)(
  'señal %s declarada por el agente con --senal: también bloquea, aunque el inventario salga limpio',
  async (tipo) => {
    writeReview(NSA, []);

    const r = await apply({ senales: [tipo] });

    expect(r.blocked).toBe(true);
    expect(r.signals).toEqual([
      {
        tipo,
        detalle: 'declarada por el agente al leer el clon',
        fuente: 'agente',
      },
    ]);
    expect(rowOf('next-safe-action/next-safe-action').estado).toBe('probado');
  },
);

test('la marca de disputa en la nota del catálogo bloquea adoptado', async () => {
  const marked = catalogText.replace(
    'Server Actions de Next.js',
    `${DISPUTA_MARK} CC 7 · AG 3 · Server Actions de Next.js`,
  );
  expect(marked).not.toBe(catalogText);
  fs.writeFileSync(catalogFile(), marked);
  writeReview(NSA, []);

  const r = await apply();

  expect(r.blocked).toBe(true);
  expect(r.signals.map((s) => [s.tipo, s.fuente])).toEqual([
    ['disputa', 'cruce'],
  ]);
});

test('las señales de varias fuentes se suman sin repetirse', async () => {
  writeReview(NSA, [
    { tipo: 'install-script', detalle: 'a' },
    { tipo: 'mcp-remoto' },
  ]);

  const r = await apply({ senales: ['mcp-remoto', 'privilegios'] });

  expect(r.signals.map((s) => s.tipo)).toEqual([
    'install-script',
    'mcp-remoto',
    'mcp-remoto', // mismo tipo, distinto detalle y fuente: dos señales
    'privilegios',
  ]);
  expect(rowOf('next-safe-action/next-safe-action').nota).toContain(
    '(install-script, mcp-remoto, privilegios)',
  );
});

test('adoptado sin review.json se rechaza y no escribe nada (falla cerrado)', async () => {
  const before = readCatalog();

  await expect(apply()).rejects.toThrow(/sin inventario.*spf review --prepare/);

  expect(readCatalog()).toBe(before);
  expect(fs.existsSync(dailyFile())).toBe(false);
});

test('probado y descartado no necesitan inventario y no tocan la nota diaria', async () => {
  const p = await apply({ estado: 'probado', nota: 'Probado en una rama.' });
  const d = await apply({
    id: AIKIT,
    estado: 'descartado',
    nota: 'Instala una decena de submódulos de terceros.',
  });

  expect([p.written, p.blocked, d.written, d.blocked]).toEqual([
    'probado',
    false,
    'descartado',
    false,
  ]);
  expect(rowOf('next-safe-action/next-safe-action').estado).toBe('probado');
  expect(rowOf('solanabr/ai-kit').estado).toBe('descartado');
  expect(fs.existsSync(dailyFile())).toBe(false);
});

test('probado se puede promover a adoptado en una segunda revisión', async () => {
  await apply({ estado: 'probado', nota: 'Probado.' });
  writeReview(NSA, []);

  const r = await apply({ nota: 'Tras una semana de uso, adoptado.' });

  expect(r.written).toBe('adoptado');
  const nota = rowOf('next-safe-action/next-safe-action').nota;
  expect(nota).toContain('Revisión 2026-10-02 (probado): Probado.');
  expect(nota).toContain(
    'Revisión 2026-10-02 (adoptado): Tras una semana de uso, adoptado.',
  );
});

test('lo que ya está adoptado o descartado, y el baseline, no se tocan', async () => {
  const text = catalogText.replace(
    '| next-safe-action/next-safe-action | library | nextjs-react | candidato |',
    '| next-safe-action/next-safe-action | library | nextjs-react | adoptado |',
  );
  fs.writeFileSync(catalogFile(), text);

  await expect(apply({ estado: 'descartado' })).rejects.toThrow(
    /ya está adoptado/,
  );
  await expect(
    apply({ id: 'github:obra/superpowers', estado: 'adoptado' }),
  ).rejects.toThrow(/baseline/);
  await expect(
    apply({ id: 'github:nadie/nada', estado: 'probado' }),
  ).rejects.toThrow(/no está en Catalogo\.md/);
  expect(readCatalog()).toBe(text);
});

test('un review.json de otro hallazgo se rechaza', async () => {
  const dir = writeReview(NSA, []);
  const json = JSON.parse(
    fs.readFileSync(path.join(dir, 'review.json'), 'utf8'),
  );
  fs.writeFileSync(
    path.join(dir, 'review.json'),
    JSON.stringify({ ...json, id: AIKIT, repo: 'solanabr/ai-kit' }),
  );

  await expect(apply()).rejects.toThrow(
    /review\.json es de github:solanabr\/ai-kit/,
  );
});

test('--nota vacía y estados no válidos se rechazan', async () => {
  writeReview(NSA, []);

  await expect(apply({ nota: '   ' })).rejects.toThrow(
    /--nota no puede estar vacía/,
  );
  expect(() => parseReviewEstado('candidato')).toThrow(/Estado no válido/);
  expect(() => parseReviewEstado('adoptado')).not.toThrow();
});

test('el aviso se añade a la nota diaria existente, al final de «Bucles abiertos», sin tocar lo demás', async () => {
  const daily = dailyFile();
  fs.writeFileSync(daily, readFixture('vault/Diario-2026-10-01.md'));
  writeReview(NSA, [{ tipo: 'privilegios' }]);
  const before = fs.readFileSync(daily, 'utf8').split('\n');

  const r = await apply();

  expect(r.dailyCreated).toBe(false);
  const after = fs.readFileSync(daily, 'utf8').split('\n');
  const added = after.filter((l) => !before.includes(l));
  expect(added).toHaveLength(2); // la línea nueva y `updated:`
  expect(added.some((l) => l.includes(NSA))).toBe(true);
  // la línea nueva queda tras los bucles que ya había y antes de «Notas del día»
  const iNew = after.findIndex((l) => l.includes(NSA));
  expect(iNew).toBeGreaterThan(
    after.findIndex((l) => l.startsWith('- Las copias de')),
  );
  expect(iNew).toBeLessThan(after.indexOf('## Notas del día'));
});

test('el clon y su review se borran al aplicar, también cuando adoptado se bloquea', async () => {
  const dir = writeReview(NSA, [{ tipo: 'install-script' }]);
  expect(fs.existsSync(dir)).toBe(true);

  await apply();

  expect(fs.existsSync(dir)).toBe(false);
});

test('cada aplicación deja una fila en runs (half review) con lo que pasó', async () => {
  writeReview(NSA, [{ tipo: 'mcp-remoto' }]);
  await apply();

  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  const rows2 = await db.select().from(runs);

  expect(rows2).toHaveLength(1);
  expect(rows2[0]).toMatchObject({
    half: 'review',
    week: '2026-W40',
    stats: { reviewed: 1, probado: 1, blocked: 1, signals: 1 },
    errorsBySource: [],
  });
});

test('si no se encuentra el vault para la nota diaria, un adoptado bloqueado no escribe nada', async () => {
  // VAULT_PATH sin 02-Proyectos dos niveles por encima
  const lonely = path.join(tmp, 'solo');
  writeTree(lonely, { 'Catalogo.md': catalogText });
  writeReview(NSA, [{ tipo: 'install-script' }]);

  await expect(apply({ vaultDir: lonely })).rejects.toThrow(/raíz del vault/);

  expect(fs.readFileSync(path.join(lonely, 'Catalogo.md'), 'utf8')).toBe(
    catalogText,
  );
});

test('formatApply cuenta lo que se escribió y por qué', async () => {
  writeReview(NSA, [
    { tipo: 'install-script', detalle: 'package.json: postinstall' },
  ]);

  const text = formatApply(await apply()).join('\n');

  expect(text).toContain(
    `⛔ ${NSA} → probado (se pidió adoptado; bloqueado por la puerta de seguridad)`,
  );
  expect(text).toContain(
    '- install-script (inventario): package.json: postinstall',
  );
  expect(text).toContain('aviso en «Bucles abiertos» (nota creada)');
});
