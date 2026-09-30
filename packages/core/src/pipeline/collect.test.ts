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
import { closeDatabases, getDb } from '../db/index.js';
import { runs, seen } from '../db/schema.js';
import { parseCatalog } from '../vault/catalogo.js';
import { readCandidatesFile } from './candidates-file.js';
import { collectWeek } from './collect.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const read = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8');
const topicSolana = JSON.parse(read('github-search/topic-solana.json'));
const recorded = (name: string) =>
  JSON.parse(read(`github-enrich/${name}`)) as {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };

const NOW = new Date('2026-09-30T12:00:00Z'); // semana 2026-W40
const QUERY = 'topic:solana pushed:>2026-09-16 stars:>=30';

// Config de prueba: una sola categoría, así hay una única consulta y coincide con
// la respuesta real grabada de esa misma búsqueda. El resto son las reglas reales.
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

let searches: Request[] = [];
let mode: 'ok' | 'fail' = 'ok';
const server = setupServer(
  http.get('https://api.github.com/search/repositories', ({ request }) => {
    searches.push(request);
    return mode === 'ok'
      ? HttpResponse.json(topicSolana)
      : HttpResponse.json({ message: 'Validation Failed' }, { status: 422 });
  }),
  // Enrich: respuestas reales grabadas para alsk1992/CloddsBot; el resto de repos
  // responde 404 como lo haría GitHub si no existe README ni package.json.
  http.get('https://api.github.com/repos/:owner/:repo/readme', ({ params }) =>
    params.owner === 'alsk1992'
      ? new HttpResponse(read('github-enrich/alsk1992__CloddsBot.readme.md'), {
          headers: {
            'content-type': 'application/vnd.github.raw+json; charset=utf-8',
          },
        })
      : HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
  http.get(
    'https://api.github.com/repos/:owner/:repo/contributors',
    ({ params }) => {
      if (params.owner !== 'alsk1992') {
        return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      }
      const r = recorded('alsk1992__CloddsBot.contributors.json');
      return new HttpResponse(JSON.stringify(r.body), {
        status: r.status,
        headers: r.headers,
      });
    },
  ),
  http.get(
    'https://api.github.com/repos/:owner/:repo/contents/package.json',
    ({ params }) =>
      params.owner === 'alsk1992'
        ? new HttpResponse(
            read('github-enrich/alsk1992__CloddsBot.package.json'),
            {
              headers: {
                'content-type':
                  'application/vnd.github.raw+json; charset=utf-8',
              },
            },
          )
        : HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
);

let repoDir: string;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-collect-'));
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), INTERESTS);
  fs.writeFileSync(
    path.join(repoDir, 'catalog.json'),
    JSON.stringify(
      parseCatalog(read('vault/Catalogo.md').replace(/\r\n/g, '\n')),
    ),
  );
  mode = 'ok';
});
afterEach(() => {
  closeDatabases();
  server.resetHandlers();
  searches = [];
  fs.rmSync(repoDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const collect = (over: Partial<Parameters<typeof collectWeek>[0]> = {}) =>
  collectWeek({
    repoDir,
    token: 'test-token',
    now: NOW,
    throttle: false,
    retryBaseMs: 1,
    ...over,
  });

test('recogida completa: lo recogido, filtrado, acotado y enriquecido queda en el fichero de la semana', async () => {
  const summary = await collect();

  expect(summary.week).toBe('2026-W40');
  expect(new URL(searches[0].url).searchParams.get('q')).toBe(QUERY);
  // 30 resultados reales; 22 pasan las reglas y 8 caen por licencia (derivado a mano de los datos)
  expect(summary.run.stats).toEqual({
    queries: 1,
    requests: 1,
    cacheHits: 0,
    rawItems: 30,
    uniqueRepos: 30,
    afterDedupe: 30,
    afterRules: 22,
    selected: 5,
    deferred: 17,
    enriched: 5,
  });
  expect(summary.run.errorsBySource).toEqual([]);

  const file = await readCandidatesFile(repoDir, '2026-W40');
  expect(file?.candidates.map((c) => c.name)).toEqual([
    'hummingbot/hummingbot',
    'otter-sec/anchor',
    'mortdeus/solana-copy-sniper-mev-trading-bot',
    'alsk1992/CloddsBot',
    'solana-foundation/solana-web3.js',
  ]);
  expect(file?.descartados).toHaveLength(8);
  expect(file?.descartados.every((d) => d.regla === 'licencia')).toBe(true);
  expect(file?.diferidos).toHaveLength(17);
  expect(file?.diferidos[0].motivo).toBe(
    'tope enrich_max=5: cuota de solana = 5 de 22',
  );
});

test('el enriquecimiento real llega al candidato: README limpio, contribuidores y postinstall', async () => {
  await collect();
  const file = await readCandidatesFile(repoDir, '2026-W40');
  const clodds = file?.candidates.find((c) => c.name === 'alsk1992/CloddsBot');

  expect(clodds?.contributors).toBe(4);
  expect(clodds?.risk).toMatchObject({
    singleMaintainer: false,
    postinstall: true,
    lifecycleScripts: ['postinstall'],
  });
  expect(clodds?.readmeExcerpt).toContain('AI-powered trading terminal');
  expect(clodds?.readmeExcerpt).not.toMatch(/<\/?[a-z][^>]*>/i);

  // sin README ni package.json ni contribuidores: queda anotado, no inventado
  const other = file?.candidates.find((c) => c.name === 'otter-sec/anchor');
  expect(other?.readmeExcerpt).toBeUndefined();
  expect(other?.risk.postinstall).toBeUndefined();
  expect(other?.risk.notes[0]).toMatch(/^Contribuidores no disponible/);
});

test('solo se marcan como vistos los que entran al batch y se registra la ejecución', async () => {
  const summary = await collect();
  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  const file = await readCandidatesFile(repoDir, '2026-W40');

  const marked = db
    .select()
    .from(seen)
    .all()
    .map((s) => s.dedupeKey)
    .sort();
  expect(marked).toEqual(file?.candidates.map((c) => c.id).sort());
  expect(marked).toHaveLength(5);

  const [row] = db.select().from(runs).all();
  expect(row).toMatchObject({
    half: 'collect',
    week: '2026-W40',
    trigger: 'manual',
    startedAt: NOW.toISOString(),
  });
  expect(row.stats).toEqual(summary.run.stats);
});

test('segunda recogida de la semana: usa la caché, no repite lo visto y fusiona con el fichero', async () => {
  await collect({ trigger: 'schedule' });
  const second = await collect({ trigger: 'workflow_dispatch' });

  // la búsqueda sale de la caché de 24 h: ninguna petición nueva
  expect(searches).toHaveLength(1);
  expect(second.run.stats).toMatchObject({
    requests: 0,
    cacheHits: 1,
    afterDedupe: 25, // 30 − los 5 ya vistos
    afterRules: 17,
    selected: 5,
    deferred: 12,
  });

  const file = await readCandidatesFile(repoDir, '2026-W40');
  expect(file?.candidates).toHaveLength(10);
  expect(file?.diferidos).toHaveLength(12);
  expect(file?.descartados).toHaveLength(8);
  expect(file?.runs.map((r) => r.trigger)).toEqual([
    'schedule',
    'workflow_dispatch',
  ]);
  expect(second.totalCandidates).toBe(10);

  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(db.select().from(seen).all()).toHaveLength(10);
  expect(db.select().from(runs).all()).toHaveLength(2);
});

test('sin token aborta antes de leer o escribir nada', async () => {
  fs.rmSync(path.join(repoDir, 'interests.yaml'));

  // si mirara primero los espejos, el error sería "No existe interests.yaml"
  await expect(collect({ token: undefined })).rejects.toThrow(
    'GITHUB_TOKEN es obligatorio',
  );
  expect(searches).toHaveLength(0);
  expect(fs.readdirSync(repoDir)).toEqual(['catalog.json']);
});

test('sin los espejos del repo no hay recogida: pide ejecutar interests sync', async () => {
  fs.rmSync(path.join(repoDir, 'interests.yaml'));
  await expect(collect()).rejects.toThrow('interests sync');
});

test('si todas las consultas fallan, la recogida falla y no deja nada a medias', async () => {
  mode = 'fail';

  await expect(collect()).rejects.toThrow(
    'Todas las consultas de github-search fallaron',
  );
  expect(fs.existsSync(path.join(repoDir, 'data', 'candidates'))).toBe(false);
  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(db.select().from(seen).all()).toEqual([]);
  expect(db.select().from(runs).all()).toEqual([]);
});

test('una fuente desconocida es un error, no se ignora', async () => {
  await expect(collect({ source: 'npm' })).rejects.toThrow(
    'Fuente no soportada: npm',
  );
});
