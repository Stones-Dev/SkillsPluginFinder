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
import { treeSnapshot } from '../testing/tree.js';
import { parseCatalog } from '../vault/catalogo.js';
import { readCandidatesFile } from './candidates-file.js';
import { collectWeek, formatDryRun } from './collect.js';

// Respuestas reales de GitHub grabadas el 2026-10-01 (ver `collectors/awesome.test.ts`):
// tres versiones del README de unicodeveloper/awesome-nextjs y los `GET /repos` de los
// enlaces que cambian entre ellas.
const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const awesomeDir = `${fixtures}/awesome`;
const LIST = 'unicodeveloper/awesome-nextjs';
const versions = JSON.parse(
  fs.readFileSync(
    `${awesomeDir}/unicodeveloper__awesome-nextjs.versions.json`,
    'utf8',
  ),
).versions as Record<string, { etag: string; contentType: string }>;
const readme = (name: string) =>
  fs.readFileSync(
    `${awesomeDir}/unicodeveloper__awesome-nextjs.readme.${name}.md`,
    'utf8',
  );
const repoFixtures = new Map<string, { status: number; body: unknown }>(
  fs
    .readdirSync(`${awesomeDir}/repos`)
    .map((f) => [
      f.replace('__', '/').replace(/\.json$/, ''),
      JSON.parse(fs.readFileSync(`${awesomeDir}/repos/${f}`, 'utf8')),
    ]),
);
const frontman = repoFixtures.get('frontman-ai/frontman')?.body as object;

const interestsYaml = (extra = '') => `version: 1
umbral_score: 7
enrich_max: 4
ventana_dias: 14
idioma_informe: es
reglas_globales:
  estrellas_min: 50
  ultimo_commit_max_dias: 400
  licencias_ok: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense]
  licencia_no_reconocida: riesgo
  excluir_forks_sin_cambios: true
  excluir_archivados: true
categorias:
  nextjs-react:
    nombre: Next.js y React
    peso: 0.9
    estrellas_min: 0
${extra}awesome_listas:
  ${LIST}: nextjs-react
proyectos:
  - CRMDecoversia — CRM comercial, Laravel 11 backend + Node/Next.js frontend
`;

let readmeVersion = '2026-01-30';
let searchItems: object[] = [];
let urls: string[] = [];
const server = setupServer(
  http.get('https://api.github.com/search/repositories', () =>
    HttpResponse.json({
      total_count: searchItems.length,
      incomplete_results: false,
      items: searchItems,
    }),
  ),
  http.get(
    'https://api.github.com/repos/:owner/:repo/readme',
    ({ request, params }) => {
      // el de la lista (modo raw, con ETag) y el de enrich de los candidatos (que aquí no existe)
      if (`${params.owner}/${params.repo}`.toLowerCase() !== LIST) {
        return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      }
      const { etag, contentType } = versions[readmeVersion];
      if (request.headers.get('if-none-match') === etag) {
        return new HttpResponse(null, { status: 304, headers: { etag } });
      }
      return new HttpResponse(readme(readmeVersion), {
        status: 200,
        headers: { etag, 'content-type': contentType },
      });
    },
  ),
  http.get('https://api.github.com/repos/:owner/:repo/contributors', () =>
    HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
  http.get(
    'https://api.github.com/repos/:owner/:repo/contents/package.json',
    () => HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
  http.get('https://api.github.com/repos/:owner/:repo', ({ params }) => {
    const fixture = repoFixtures.get(
      `${params.owner}/${params.repo}`.toLowerCase(),
    );
    return fixture
      ? HttpResponse.json(fixture.body as object, { status: fixture.status })
      : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),
);

let repoDir: string;
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', ({ request }) => urls.push(request.url));
});
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-awesome-pipeline-'));
  writeInterests(interestsYaml());
  fs.writeFileSync(
    path.join(repoDir, 'catalog.json'),
    JSON.stringify(
      parseCatalog(
        fs
          .readFileSync(`${fixtures}/vault/Catalogo.md`, 'utf8')
          .replace(/\r\n/g, '\n'),
      ),
    ),
  );
  readmeVersion = '2026-01-30';
  searchItems = [];
  urls = [];
});
afterEach(() => {
  closeDatabases();
  server.resetHandlers();
  fs.rmSync(repoDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const writeInterests = (yaml: string) =>
  fs.writeFileSync(path.join(repoDir, 'interests.yaml'), yaml);
const W40 = new Date('2026-09-30T12:00:00Z');
const W41 = new Date('2026-10-05T12:00:00Z');
const base = (now: Date) => ({
  repoDir,
  token: 'test-token',
  now,
  throttle: false,
  retryBaseMs: 1,
});
const snapshotFile = () =>
  path.join(repoDir, 'data', 'awesome', 'unicodeveloper-awesome-nextjs.json');
const snapshot = () => JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'));
const dbRuns = () =>
  getDb(path.join(repoDir, 'data', 'seen.sqlite'))
    .select()
    .from(runs)
    .all();

test('ciclo completo: primera pasada sin candidatos, novedades que pasan las reglas, tope enrich_max que difiere, y 304', async () => {
  // — Semana 40, primera pasada: solo la instantánea —
  const first = await collectWeek(base(W40));
  expect(first.run.stats).toMatchObject({
    queries: 0,
    awesomeLists: 1,
    awesomeNuevos: 0,
    awesomeResueltos: 0,
    awesomePendientes: 0,
  });
  expect(first.totalCandidates).toBe(0);
  expect(snapshot().links).toHaveLength(108);
  expect(snapshot().etag).toBe(versions['2026-01-30'].etag);

  // — Semana 41: el README real de hoy trae 8 enlaces nuevos —
  readmeVersion = 'current';
  const second = await collectWeek(base(W41));

  // reglas, derivadas a mano de los repos reales: farming-labs/docs y a827681306/devtoolkit no
  // tienen licencia → descartados; NOASSERTION pasa (licencia_no_reconocida: riesgo); los 6
  // restantes superan estrellas_min 0 y los 400 días de inactividad.
  expect(second.run.stats).toMatchObject({
    queries: 0,
    uniqueRepos: 8,
    afterDedupe: 8,
    afterRules: 6,
    selected: 4,
    deferred: 2,
    enriched: 4,
    awesomeLists: 1,
    awesomeRequests: 9, // el README + 8 GET /repos
    awesomeNotModified: 0,
    awesomeNuevos: 8,
    awesomeResueltos: 8,
    awesomePendientes: 0,
  });
  const afterSecond = await readCandidatesFile(repoDir, '2026-W41');
  // ninguno se creó en los últimos 14 días: manda el push más reciente (fim-one y frontman,
  // 2026-10-01, desempatan por nombre), luego a11y-starter-kit-code y kaiforge-lite
  expect(afterSecond?.candidates.map((c) => c.name)).toEqual([
    'fim-ai/fim-one',
    'frontman-ai/frontman',
    'thefrontkit/a11y-starter-kit-code',
    'DevxiaLabs/kaiforge-lite',
  ]);
  for (const c of afterSecond?.candidates ?? []) {
    expect(c.source).toBe('awesome-list');
    expect(c.categoriaSugerida).toBe('nextjs-react');
    expect(c.origins).toEqual([
      { categoria: 'nextjs-react', tipo: 'awesome', query: LIST },
    ]);
  }
  expect(afterSecond?.descartados.map((d) => [d.name, d.regla]).sort()).toEqual(
    [
      ['a827681306/devtoolkit', 'licencia'],
      ['farming-labs/docs', 'licencia'],
    ],
  );
  expect(afterSecond?.diferidos.map((d) => d.name)).toEqual([
    'nicepkg/shotog',
    'ArtemZhyto/modal-layout-component',
  ]);
  // los dos diferidos no se dan por vistos: fuera de la instantánea y sin ETag, volverán
  expect(snapshot().links).toHaveLength(116 - 2);
  expect(snapshot().links).not.toContain('nicepkg/shotog');
  expect(snapshot().links).not.toContain('artemzhyto/modal-layout-component');
  expect(snapshot().etag).toBeNull();

  // — Segunda ejecución de la misma semana: solo los dos diferidos, ahora sí caben —
  urls = [];
  const third = await collectWeek(base(new Date('2026-10-06T12:00:00Z')));
  expect(third.run.stats).toMatchObject({
    awesomeNuevos: 2,
    awesomeResueltos: 2,
    afterRules: 2,
    selected: 2,
    deferred: 0,
  });
  expect(urls.filter((u) => /\/repos\/[^/]+\/[^/]+$/.test(u)).sort()).toEqual([
    'https://api.github.com/repos/artemzhyto/modal-layout-component',
    'https://api.github.com/repos/nicepkg/shotog',
  ]);
  const afterThird = await readCandidatesFile(repoDir, '2026-W41');
  expect(afterThird?.candidates).toHaveLength(6);
  expect(afterThird?.diferidos).toEqual([]);
  expect(snapshot().links).toHaveLength(116);
  expect(snapshot().etag).toBe(versions.current.etag);

  // — Y con todo al día, la lista contesta 304 y no se resuelve nada —
  urls = [];
  const fourth = await collectWeek(base(new Date('2026-10-07T12:00:00Z')));
  expect(fourth.run.stats).toMatchObject({
    awesomeRequests: 1,
    awesomeNotModified: 1,
    awesomeNuevos: 0,
    selected: 0,
  });
  expect(urls.filter((u) => /\/repos\/[^/]+\/[^/]+$/.test(u))).toEqual([]);

  // lo visto y lo registrado
  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(db.select().from(seen).all()).toHaveLength(6);
  expect(dbRuns()).toHaveLength(4);
});

test('un repo que sale de la búsqueda y de la lista es un solo candidato con los dos orígenes', async () => {
  writeInterests(interestsYaml('    topics: [nextjs]\n'));
  await collectWeek(base(W40)); // primera pasada; la búsqueda no devuelve nada
  readmeVersion = 'current';
  searchItems = [frontman];

  const run = await collectWeek(base(W41));

  expect(run.run.stats).toMatchObject({
    queries: 1,
    rawItems: 1 + 8, // 1 de la búsqueda + 8 resueltos de la lista
    uniqueRepos: 8, // frontman cuenta una vez
  });
  const file = await readCandidatesFile(repoDir, '2026-W41');
  const merged = file?.candidates.find(
    (c) => c.name === 'frontman-ai/frontman',
  );
  expect(merged?.source).toBe('github-search');
  expect(merged?.origins).toEqual([
    { categoria: 'nextjs-react', tipo: 'topic', query: 'nextjs' },
    { categoria: 'nextjs-react', tipo: 'awesome', query: LIST },
  ]);
  expect(
    file?.candidates.filter((c) => c.name === 'frontman-ai/frontman'),
  ).toHaveLength(1);
});

test('--source awesome-list recoge solo la lista; github-search no se ejecuta', async () => {
  writeInterests(interestsYaml('    topics: [nextjs]\n'));
  searchItems = [frontman];

  const run = await collectWeek({ ...base(W40), source: 'awesome-list' });

  expect(run.run.stats.queries).toBe(0);
  expect(urls.some((u) => u.includes('/search/repositories'))).toBe(false);
  expect(run.run.stats.awesomeLists).toBe(1);
});

test('--source github-search no toca las listas; y --source awesome-list sin awesome_listas es un error', async () => {
  writeInterests(interestsYaml('    topics: [nextjs]\n'));
  await collectWeek({ ...base(W40), source: 'github-search' });
  expect(fs.existsSync(path.join(repoDir, 'data', 'awesome'))).toBe(false);
  expect(urls.some((u) => u.includes('/repos/'))).toBe(false);

  writeInterests(interestsYaml().replace(/awesome_listas:\n {2}.*\n/, ''));
  await expect(
    collectWeek({ ...base(W40), source: 'awesome-list' }),
  ).rejects.toThrow('Sin listas que recoger');
  await expect(collectWeek({ ...base(W40), source: 'hn' })).rejects.toThrow(
    'solo github-search, awesome-list',
  );
});

test('si todas las listas fallan y es la única fuente, la recogida falla sin escribir candidatos', async () => {
  server.use(
    http.get('https://api.github.com/repos/:owner/:repo/readme', () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
  );
  await expect(
    collectWeek({ ...base(W40), source: 'awesome-list' }),
  ).rejects.toThrow('Todas las listas de awesome-list fallaron');
  expect(fs.existsSync(path.join(repoDir, 'data', 'candidates'))).toBe(false);
});

test('si la recogida falla a mitad, las instantáneas siguen siendo las anteriores y no se pierden novedades', async () => {
  await collectWeek(base(W40));
  const before = treeSnapshot(path.join(repoDir, 'data', 'awesome'));
  readmeVersion = 'current';
  // el fichero de la semana no se puede escribir (un directorio ocupa el nombre de su temporal):
  // la recogida revienta después de ver las novedades de la lista y de enriquecerlas, justo al
  // dejarlas en candidatos
  const blocker = path.join(
    repoDir,
    'data',
    'candidates',
    `2026-W41.json.${process.pid}.tmp`,
  );
  fs.mkdirSync(blocker, { recursive: true });

  await expect(collectWeek(base(W41))).rejects.toThrow();

  expect(treeSnapshot(path.join(repoDir, 'data', 'awesome'))).toEqual(before);
  expect(dbRuns()).toHaveLength(1); // solo la de la primera pasada
  // y cuando el problema se arregla, las 8 novedades siguen ahí
  fs.rmSync(blocker, { recursive: true });
  const retry = await collectWeek(base(W41));
  expect(retry.run.stats).toMatchObject({ awesomeNuevos: 8, selected: 4 });
});

test('dry-run sin instantánea: la crea (única escritura) y no toca nada más de data/', async () => {
  const result = await collectWeek({ ...base(W40), dryRun: true });

  expect(result.awesome?.snapshotsCreadas).toBe(1);
  expect(result.awesome?.listas[0]).toMatchObject({
    repo: LIST,
    estado: 'primera-pasada',
    enlaces: 108,
  });
  expect(Object.keys(treeSnapshot(path.join(repoDir, 'data')))).toEqual([
    path.join('awesome', 'unicodeveloper-awesome-nextjs.json'),
  ]);
  expect(snapshot().links).toHaveLength(108);
});

test('dry-run con instantánea: cuenta las novedades de verdad y no sobrescribe nada; data/ idéntico', async () => {
  await collectWeek(base(W40)); // instantánea del 2026-01-30 hecha por una recogida real
  closeDatabases();
  readmeVersion = 'current';
  const data = path.join(repoDir, 'data');
  const before = treeSnapshot(data);

  const result = await collectWeek({ ...base(W41), dryRun: true });
  closeDatabases();

  expect(treeSnapshot(data)).toEqual(before);
  expect(result.awesome).toMatchObject({ snapshotsCreadas: 0 });
  expect(result.awesome?.listas[0]).toMatchObject({
    estado: 'con-cambios',
    nuevos: 8,
    resueltos: 8,
  });
  expect(result.stats).toMatchObject({
    afterRules: 6,
    selected: 4,
    deferred: 2,
  });
  expect(result.fuentes).toEqual(['github-search', 'awesome-list']);
  // un segundo ensayo ve exactamente lo mismo: la instantánea no se la comió el primero
  const again = await collectWeek({ ...base(W41), dryRun: true });
  expect(again.awesome?.listas[0]).toMatchObject({ nuevos: 8 });

  const text = formatDryRun(result).join('\n');
  expect(text).toContain(
    'DRY-RUN · semana 2026-W41 · github-search + awesome-list — no se escribe nada',
  );
  expect(text).toContain('salvo las instantáneas de data/awesome que falten');
  expect(text).toContain(
    'awesome-list: 1 listas · 9 peticiones core (0 READMEs con 304) · instantáneas creadas: 0',
  );
  expect(text).toMatch(
    /unicodeveloper\/awesome-nextjs\s+con cambios · 116 enlaces · \+8 -0 \(resueltos 8, desaparecidos 0, pendientes 0\) → nextjs-react/,
  );
});
