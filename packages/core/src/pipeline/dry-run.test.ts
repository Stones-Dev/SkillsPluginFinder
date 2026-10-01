import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'vitest';
import { closeDatabases, getDb, getReadonlyDb } from '../db/index.js';
import { runs, seen } from '../db/schema.js';
import { parseCatalog } from '../vault/catalogo.js';
import { collectWeek, formatDryRun } from './collect.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const read = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8');
// Los 30 resultados reales de `topic:solana pushed:>… stars:>=30` (grabados el 2026-09-30).
const topicSolana = JSON.parse(read('github-search/topic-solana.json'));

const NOW = new Date('2026-09-30T12:00:00Z'); // semana 2026-W40
const INTERESTS = `version: 1
umbral_score: 7
enrich_max: 5
ventana_dias: 14
idioma_informe: es
reglas_globales:
  estrellas_min: 50
  ultimo_commit_max_dias: 90
  licencias_ok: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense]
  excluir_forks_sin_cambios: true
  excluir_archivados: true
categorias:
  solana:
    nombre: Blockchain Solana
    peso: 0.8
    estrellas_min: 30
    topics: [solana]
excluir:
  - "*/awesome-*"
proyectos:
  - SonarTrench — bot de alertas memecoins Solana
`;

let urls: string[] = [];
let failSearch = false;
const server = setupServer(
  http.get('https://api.github.com/search/repositories', () =>
    failSearch
      ? HttpResponse.json({ message: 'Validation Failed' }, { status: 422 })
      : HttpResponse.json(topicSolana),
  ),
  // Solo la recogida real (que siembra el estado previo) enriquece; el dry-run no debe llegar aquí.
  http.get('https://api.github.com/repos/:owner/:repo/readme', () =>
    HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
  http.get('https://api.github.com/repos/:owner/:repo/contributors', () =>
    HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
  http.get(
    'https://api.github.com/repos/:owner/:repo/contents/package.json',
    () => HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
);

let repoDir: string;
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', ({ request }) => urls.push(request.url));
});
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-dryrun-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), INTERESTS);
  fs.writeFileSync(
    path.join(repoDir, 'catalog.json'),
    JSON.stringify(
      parseCatalog(read('vault/Catalogo.md').replace(/\r\n/g, '\n')),
    ),
  );
  failSearch = false;
  urls = [];
});
afterEach(() => {
  closeDatabases();
  server.resetHandlers();
  fs.rmSync(repoDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const options = (over: Partial<Parameters<typeof collectWeek>[0]> = {}) => ({
  repoDir,
  token: 'test-token',
  now: NOW,
  throttle: false,
  retryBaseMs: 1,
  ...over,
});
const dryRun = (over: Partial<Parameters<typeof collectWeek>[0]> = {}) =>
  collectWeek({ ...options(over), dryRun: true });
const collect = (over: Partial<Parameters<typeof collectWeek>[0]> = {}) =>
  collectWeek(options(over));

/** Cada fichero de `dir` con su tamaño, su fecha de modificación y su SHA-256. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const stat = fs.statSync(file);
      const sha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex');
      out[path.relative(dir, file)] = `${stat.size}|${stat.mtimeMs}|${sha}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test('sin data/ en absoluto: el ensayo no crea ni el directorio, ni la base, ni la caché', async () => {
  const before = snapshot(repoDir);

  const r = await dryRun();

  expect(r.dryRun).toBe(true);
  expect(fs.existsSync(path.join(repoDir, 'data'))).toBe(false);
  expect(snapshot(repoDir)).toEqual(before);
  expect(r.seenLeida).toBe(false); // no había seen.sqlite: nada que comparar
  expect(r.week).toBe('2026-W40');
});

test('con data/ ya poblado (recogida real previa) el árbol queda idéntico: hash, tamaño y fecha de cada fichero', async () => {
  await collect(); // siembra candidates, seen.sqlite, runs y la caché
  closeDatabases();
  const data = path.join(repoDir, 'data');
  const before = snapshot(data);
  expect(Object.keys(before).some((f) => f.startsWith('candidates'))).toBe(
    true,
  );
  expect(Object.keys(before).some((f) => f.startsWith('cache'))).toBe(true);
  expect(Object.keys(before)).toContain('seen.sqlite');
  urls = [];

  const r = await dryRun();
  closeDatabases();

  expect(snapshot(data)).toEqual(before);
  expect(r.seenLeida).toBe(true);
  // no leyó la caché (hace la búsqueda de verdad) y no enriqueció nada
  expect(urls.filter((u) => u.includes('/search/repositories'))).toHaveLength(
    1,
  );
  expect(urls.filter((u) => u.includes('/repos/'))).toEqual([]);
});

test('no escribe en la base: ni seen ni runs cambian, y la conexión rechaza escrituras', async () => {
  await collect();
  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  const seenBefore = db.select().from(seen).all().length;
  const runsBefore = db.select().from(runs).all().length;
  expect([seenBefore, runsBefore]).toEqual([5, 1]);
  closeDatabases();

  await dryRun();
  closeDatabases();

  const after = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(after.select().from(seen).all()).toHaveLength(5);
  expect(after.select().from(runs).all()).toHaveLength(1);
  closeDatabases();

  const readonly = getReadonlyDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(readonly).not.toBeNull();
  expect(() =>
    readonly?.insert(seen).values({ id: 'x', dedupeKey: 'x' }).run(),
  ).toThrow(/readonly/i);
  expect(getReadonlyDb(path.join(repoDir, 'no-existe.sqlite'))).toBeNull();
});

test('los mismos números que la recogida real (colector, dedupe, reglas y tope)', async () => {
  const dry = await dryRun();
  const real = await collect();

  expect(dry.stats).toEqual({
    queries: real.run.stats.queries,
    requests: real.run.stats.requests,
    rawItems: real.run.stats.rawItems,
    uniqueRepos: real.run.stats.uniqueRepos,
    afterDedupe: real.run.stats.afterDedupe,
    afterRules: real.run.stats.afterRules,
    selected: real.run.stats.selected,
    deferred: real.run.stats.deferred,
  });
  // 30 resultados reales: 22 pasan las reglas y 8 caen por licencia; entran 5 y se difieren 17
  expect(dry.stats).toMatchObject({
    rawItems: 30,
    afterRules: 22,
    selected: 5,
    deferred: 17,
  });
  expect(dry.descartadosPorRegla).toEqual({ licencia: 8 });
  expect(dry.categorias).toEqual([
    { categoria: 'solana', elegibles: 22, seleccionados: 5, diferidos: 17 },
  ]);
  expect(dry.enrichRequestsEstimadas).toBe(15);
  expect(dry.muestra.map((m) => m.name)).toEqual([
    'cake-tech/cake_wallet',
    'rango-exchange/rango-client',
    'otter-sec/anchor',
    'anza-xyz/kit',
    'hyperledger-solang/solang',
  ]);
});

test('el dedupe lee lo ya visto: tras una recogida real, el ensayo no vuelve a proponer esos 5', async () => {
  await collect();
  closeDatabases();

  const r = await dryRun();

  expect(r.stats.afterDedupe).toBe(25); // 30 - los 5 marcados como vistos
  expect(r.stats.selected).toBe(5);
  expect(r.muestra.map((m) => m.name)).not.toContain('cake-tech/cake_wallet');
});

test('mismas garantías que la recogida real: sin token aborta antes de la red, y si todas las consultas fallan, falla', async () => {
  await expect(dryRun({ token: undefined })).rejects.toThrow(
    'GITHUB_TOKEN es obligatorio',
  );
  expect(urls).toEqual([]);

  failSearch = true;
  await expect(dryRun()).rejects.toThrow(
    'Todas las consultas de github-search fallaron',
  );
  expect(fs.existsSync(path.join(repoDir, 'data'))).toBe(false);
});

test('una fuente desconocida también es un error en el ensayo', async () => {
  await expect(dryRun({ source: 'npm' })).rejects.toThrow(
    'Fuente no soportada: npm',
  );
});

test('formatDryRun dice que no se escribe nada y cuenta lo que pasaría', async () => {
  const text = formatDryRun(await dryRun()).join('\n');

  expect(text).toContain(
    'DRY-RUN · semana 2026-W40 · github-search — no se escribe nada',
  );
  expect(text).toContain(
    '1 consultas → 1 peticiones de búsqueda → 30 resultados → 30 repos únicos',
  );
  expect(text).toContain('sin seen.sqlite: nada visto');
  expect(text).toContain('tras reglas: 22 (8 descartados: licencia 8)');
  expect(text).toContain(
    'entrarían al batch: 5 · diferidos por el tope: 17 · el enrich gastaría ~15 peticiones core',
  );
  expect(text).toMatch(/solana\s+22 →\s+5 \(\+17\)/);
  expect(text).toContain('cake-tech/cake_wallet');
});
