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
import { parseInterestsYaml } from '../config/interests.js';
import {
  type AwesomeResult,
  collectFromAwesomeLists,
  extractRepoLinks,
  finalizeSnapshots,
  snapshotPath,
  writeAwesomeSnapshots,
} from './awesome.js';
import { MissingTokenError } from './github-client.js';

// Todo lo que sirve el servidor son respuestas reales de GitHub grabadas el 2026-10-01:
// tres versiones del README de unicodeveloper/awesome-nextjs (con su ETag y su commit) y
// `GET /repos/{owner}/{repo}` de los enlaces que cambian entre ellas.
const dir = path.resolve(import.meta.dirname, '../../tests/fixtures/awesome');
const LIST = 'unicodeveloper/awesome-nextjs';
const versions = JSON.parse(
  fs.readFileSync(
    `${dir}/unicodeveloper__awesome-nextjs.versions.json`,
    'utf8',
  ),
).versions as Record<string, { etag: string; contentType: string }>;
const readme = (name: string) =>
  fs.readFileSync(
    `${dir}/unicodeveloper__awesome-nextjs.readme.${name}.md`,
    'utf8',
  );
const repoFixtures = new Map<string, { status: number; body: unknown }>(
  fs
    .readdirSync(`${dir}/repos`)
    .map((f) => [
      f.replace('__', '/').replace(/\.json$/, ''),
      JSON.parse(fs.readFileSync(`${dir}/repos/${f}`, 'utf8')),
    ]),
);

// Lo que cambia en la lista, medido con una regex independiente sobre los mismos ficheros:
// 108 enlaces el 2026-01-30, 120 el 2026-09-10 y 116 hoy.
const ADDED_SINCE_JANUARY = [
  'devxialabs/kaiforge-lite',
  'thefrontkit/a11y-starter-kit-code',
  'artemzhyto/modal-layout-component',
  'nicepkg/shotog',
  'frontman-ai/frontman',
  'farming-labs/docs',
  'a827681306/devtoolkit',
  'fim-ai/fim-agent',
];
const REMOVED_SINCE_SEPTEMBER = [
  'vette1123/movies-streaming-platform',
  'armor229-ux/file-flex',
  'saad-web-spec/devscratchpad',
  'gibbok/typescript-book',
];

type ListState = { text: string; version: string };
const lists = new Map<string, ListState>();
let readmeRequests: {
  repo: string;
  accept: string | null;
  ifNoneMatch: string | null;
}[] = [];
let repoCalls: string[] = [];
const repoStatus = new Map<string, number>();

const server = setupServer(
  http.get(
    'https://api.github.com/repos/:owner/:repo/readme',
    ({ request, params }) => {
      const repo = `${params.owner}/${params.repo}`.toLowerCase();
      readmeRequests.push({
        repo,
        accept: request.headers.get('accept'),
        ifNoneMatch: request.headers.get('if-none-match'),
      });
      const list = lists.get(repo);
      if (!list) {
        return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      }
      const { etag, contentType } = versions[list.version];
      if (request.headers.get('if-none-match') === etag) {
        return new HttpResponse(null, { status: 304, headers: { etag } });
      }
      return new HttpResponse(list.text, {
        status: 200,
        headers: { etag, 'content-type': contentType },
      });
    },
  ),
  http.get('https://api.github.com/repos/:owner/:repo', ({ params }) => {
    const repo = `${params.owner}/${params.repo}`.toLowerCase();
    repoCalls.push(repo);
    const forced = repoStatus.get(repo);
    if (forced) {
      return HttpResponse.json({ message: 'forced' }, { status: forced });
    }
    const fixture = repoFixtures.get(repo);
    if (!fixture) {
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }
    return HttpResponse.json(fixture.body as object, {
      status: fixture.status,
    });
  }),
);

const interests = parseInterestsYaml(`
version: 1
categorias:
  nextjs-react:
    nombre: Next.js y React
    peso: 0.9
  frontend-bonito:
    nombre: Frontends
    peso: 0.9
awesome_listas:
  ${LIST}: nextjs-react
`);
const NOW = new Date('2026-10-01T12:00:00Z');

let snapshotDir: string;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-awesome-'));
  lists.clear();
  readmeRequests = [];
  repoCalls = [];
  repoStatus.clear();
});
afterEach(() => {
  server.resetHandlers();
  fs.rmSync(snapshotDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const setReadme = (version: string, repo = LIST) =>
  lists.set(repo, {
    text: version === 'current' ? readme('current') : readme(version),
    version,
  });
const collect = (
  over: Partial<Parameters<typeof collectFromAwesomeLists>[0]> = {},
) =>
  collectFromAwesomeLists({
    token: 'test-token',
    interests,
    now: NOW,
    snapshotDir,
    throttle: false,
    retryBaseMs: 1,
    ...over,
  });
/** Una pasada completa: recoge y guarda, como hace el pipeline al terminar. */
async function pass(
  version: string,
  over: Partial<Parameters<typeof collectFromAwesomeLists>[0]> = {},
  deferred: string[] = [],
): Promise<AwesomeResult> {
  setReadme(version);
  const result = await collect(over);
  await writeAwesomeSnapshots(finalizeSnapshots(result, deferred));
  return result;
}
const readSnapshot = (repo = LIST) =>
  JSON.parse(fs.readFileSync(snapshotPath(snapshotDir, repo), 'utf8'));

test('extractRepoLinks: solo github.com/<owner>/<repo>, sin repetidos, en orden y sin la propia lista', () => {
  const links = extractRepoLinks(
    [
      '- [A](https://github.com/Foo/Bar) y [otra vez](http://www.github.com/foo/bar/tree/main/docs#readme)',
      '- [B](https://github.com/baz/qux.git) · <a href="https://github.com/zed/zap.">fin de frase</a>',
      '- [la lista](https://github.com/unicodeveloper/awesome-nextjs/blob/main/README.md)',
      '- [topic](https://github.com/topics/solana) [sponsor](https://github.com/sponsors/foo) [orgs](https://github.com/orgs/acme/people)',
      '- [solo dueño](https://github.com/owner-only) [badge](https://img.shields.io/github/stars/foo/bar) [raw](https://raw.githubusercontent.com/x/y/main/a.md)',
    ].join('\n'),
    LIST,
  );
  expect(links).toEqual(['foo/bar', 'baz/qux', 'zed/zap']);
});

test('extractRepoLinks sobre los tres README reales: 108, 120 y 116 enlaces, como mide una regex independiente', () => {
  expect(extractRepoLinks(readme('2026-01-30'), LIST)).toHaveLength(108);
  expect(extractRepoLinks(readme('2026-09-10'), LIST)).toHaveLength(120);
  expect(extractRepoLinks(readme('current'), LIST)).toHaveLength(116);
});

test('primera pasada: se pide el README en raw, se anota la instantánea y NO hay candidatos ni peticiones a /repos', async () => {
  const result = await pass('2026-01-30');

  expect(readmeRequests).toEqual([
    {
      repo: LIST,
      accept: 'application/vnd.github.raw+json',
      ifNoneMatch: null,
    },
  ]);
  expect(repoCalls).toEqual([]);
  expect(result.repos).toEqual([]);
  expect(result.lists).toEqual([
    {
      repo: LIST,
      categoria: 'nextjs-react',
      estado: 'primera-pasada',
      enlaces: 108,
      nuevos: 0,
      quitados: 0,
      resueltos: 0,
      desaparecidos: 0,
      pendientes: 0,
    },
  ]);
  const snapshot = readSnapshot();
  expect(snapshot).toMatchObject({
    version: 1,
    repo: LIST,
    etag: versions['2026-01-30'].etag,
    fetchedAt: '2026-10-01T12:00:00.000Z',
  });
  expect(snapshot.links).toHaveLength(108);
  expect([...snapshot.links].sort()).toEqual(snapshot.links);
  expect(path.basename(snapshotPath(snapshotDir, LIST))).toBe(
    'unicodeveloper-awesome-nextjs.json',
  );
});

test('el diff real entre dos versiones: los 8 enlaces nuevos se resuelven con GET /repos y salen con su origen awesome', async () => {
  await pass('2026-01-30');
  repoCalls = [];

  const result = await pass('current');

  expect(readmeRequests.at(-1)).toEqual({
    repo: LIST,
    accept: 'application/vnd.github.raw+json',
    ifNoneMatch: versions['2026-01-30'].etag,
  });
  expect(result.lists[0]).toMatchObject({
    estado: 'con-cambios',
    enlaces: 116,
    nuevos: 8,
    quitados: 0,
    resueltos: 8,
    desaparecidos: 0,
    pendientes: 0,
  });
  expect([...repoCalls].sort()).toEqual([...ADDED_SINCE_JANUARY].sort());
  // fim-ai/fim-agent se renombró a fim-ai/fim-one: GitHub redirige y el candidato lleva el nombre vigente
  expect(result.repos.map((r) => r.repo.full_name).sort()).toEqual(
    [
      'DevxiaLabs/kaiforge-lite',
      'thefrontkit/a11y-starter-kit-code',
      'ArtemZhyto/modal-layout-component',
      'nicepkg/shotog',
      'frontman-ai/frontman',
      'farming-labs/docs',
      'a827681306/devtoolkit',
      'fim-ai/fim-one',
    ].sort(),
  );
  for (const { origins } of result.repos) {
    expect(origins).toEqual([
      { categoria: 'nextjs-react', tipo: 'awesome', query: LIST },
    ]);
  }
  expect(result.stats).toMatchObject({
    lists: 1,
    notModified: 0,
    nuevos: 8,
    resueltos: 8,
    pendientes: 0,
  });
  // la instantánea ya es la de hoy: 116 enlaces y la ETag nueva
  expect(readSnapshot()).toMatchObject({
    etag: versions.current.etag,
    links: expect.any(Array),
  });
  expect(readSnapshot().links).toHaveLength(116);
});

test('los enlaces que desaparecen del README se cuentan como quitados y no generan candidatos', async () => {
  await pass('2026-09-10');
  repoCalls = [];

  const result = await pass('current');

  expect(result.lists[0]).toMatchObject({
    estado: 'con-cambios',
    enlaces: 116,
    nuevos: 0,
    quitados: 4,
  });
  expect(repoCalls).toEqual([]);
  expect(result.repos).toEqual([]);
  // y el README real de septiembre tenía justamente esos cuatro de más
  const before = new Set(extractRepoLinks(readme('2026-09-10'), LIST));
  const now = new Set(extractRepoLinks(readme('current'), LIST));
  expect([...before].filter((l) => !now.has(l)).sort()).toEqual(
    [...REMOVED_SINCE_SEPTEMBER].sort(),
  );
});

test('un 304 con la ETag de la instantánea no baja el README ni resuelve nada', async () => {
  await pass('current');
  repoCalls = [];

  const result = await collect();

  expect(readmeRequests.at(-1)?.ifNoneMatch).toBe(versions.current.etag);
  expect(result.lists[0]).toMatchObject({
    estado: 'sin-cambios',
    enlaces: null,
    nuevos: 0,
  });
  expect(result.stats).toMatchObject({ notModified: 1, requests: 1 });
  expect(result.drafts).toEqual([]); // nada que reescribir
  expect(repoCalls).toEqual([]);
});

test('el tope por lista deja el resto pendiente: no entran en la instantánea y la ETag se anula para volver a verlos', async () => {
  await pass('2026-01-30');
  repoCalls = [];

  const first = await pass('current', { maxNewPerList: 3 });

  expect(first.lists[0]).toMatchObject({
    nuevos: 8,
    resueltos: 3,
    pendientes: 5,
  });
  expect(repoCalls).toHaveLength(3);
  const snapshot = readSnapshot();
  expect(snapshot.etag).toBeNull();
  expect(snapshot.links).toHaveLength(108 + 3);
  // los tres primeros, en el orden del README
  const inReadme = extractRepoLinks(readme('current'), LIST);
  const firstThree = inReadme
    .filter((l) => ADDED_SINCE_JANUARY.includes(l))
    .slice(0, 3);
  expect(snapshot.links).toEqual(expect.arrayContaining(firstThree));

  repoCalls = [];
  const second = await pass('current', { maxNewPerList: 3 });
  // sin ETag en la instantánea no hay If-None-Match: el README se descarga y se ven los 5 que faltan
  expect(readmeRequests.at(-1)?.ifNoneMatch).toBeNull();
  expect(second.lists[0]).toMatchObject({
    nuevos: 5,
    resueltos: 3,
    pendientes: 2,
  });

  const third = await pass('current', { maxNewPerList: 3 });
  expect(third.lists[0]).toMatchObject({
    nuevos: 2,
    resueltos: 2,
    pendientes: 0,
  });
  // entre las tres semanas han salido los 8, ni uno más ni uno menos, sin repetir
  const names = [...first.repos, ...second.repos, ...third.repos].map((r) =>
    r.repo.full_name.toLowerCase(),
  );
  expect(new Set(names).size).toBe(8);
  expect(names).toHaveLength(8);
  expect(readSnapshot().links).toHaveLength(116);
  expect(readSnapshot().etag).toBe(versions.current.etag);
});

test('los candidatos que el tope enrich_max difirió siguen siendo nuevos la próxima semana (también si el repo se renombró)', async () => {
  await pass('2026-01-30');
  setReadme('current');
  const result = await collect();

  // «fim-one» es el nombre vigente de un enlace que el README escribe como fim-agent
  const writes = finalizeSnapshots(result, [
    'fim-ai/fim-one',
    'nicepkg/shotog',
  ]);

  expect(writes).toHaveLength(1);
  expect(writes[0].snapshot.etag).toBeNull();
  expect(writes[0].snapshot.links).toHaveLength(116 - 2);
  expect(writes[0].snapshot.links).not.toContain('fim-ai/fim-agent');
  expect(writes[0].snapshot.links).not.toContain('nicepkg/shotog');
  expect(writes[0].snapshot.links).toContain('frontman-ai/frontman');
});

test('un enlace que ya no existe (404) se da por visto; uno con error transitorio (500) vuelve la semana siguiente', async () => {
  await pass('2026-01-30');
  repoStatus.set('nicepkg/shotog', 404);
  repoStatus.set('frontman-ai/frontman', 500);

  const result = await pass('current');

  expect(result.lists[0]).toMatchObject({
    nuevos: 8,
    resueltos: 6,
    desaparecidos: 1,
    pendientes: 1,
  });
  expect(result.errors).toEqual([
    {
      source: 'awesome-list',
      query: LIST,
      message: expect.stringContaining('1 enlaces sin resolver'),
    },
  ]);
  expect(result.errors[0].message).toContain('frontman-ai/frontman');
  const snapshot = readSnapshot();
  expect(snapshot.links).toContain('nicepkg/shotog'); // desaparecido: no se reintenta
  expect(snapshot.links).not.toContain('frontman-ai/frontman'); // pendiente
  expect(snapshot.etag).toBeNull();

  // la semana siguiente solo queda ese
  repoStatus.clear();
  repoCalls = [];
  const next = await pass('current');
  expect(repoCalls).toEqual(['frontman-ai/frontman']);
  expect(next.repos.map((r) => r.repo.full_name)).toEqual([
    'frontman-ai/frontman',
  ]);
  expect(readSnapshot().etag).toBe(versions.current.etag);
});

test('si una lista falla, las demás siguen y el fallo queda en errors', async () => {
  const two = parseInterestsYaml(`
version: 1
categorias:
  nextjs-react: { nombre: Next, peso: 0.9 }
awesome_listas:
  acme/awesome-que-no-existe: nextjs-react
  ${LIST}: nextjs-react
`);
  setReadme('2026-01-30');

  const result = await collect({ interests: two });

  expect(result.lists.map((l) => [l.repo, l.estado])).toEqual([
    ['acme/awesome-que-no-existe', 'error'],
    [LIST, 'primera-pasada'],
  ]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatchObject({
    source: 'awesome-list',
    query: 'acme/awesome-que-no-existe',
  });
  expect(result.drafts).toHaveLength(1);
});

test('una instantánea corrupta o de otra lista no se sobrescribe: error y se sigue', async () => {
  fs.writeFileSync(snapshotPath(snapshotDir, LIST), '{ esto no es json');
  setReadme('current');

  const result = await collect();

  expect(result.lists[0].estado).toBe('error');
  expect(result.errors[0].message).toContain(
    'no es JSON válido; no se sobrescribe',
  );
  expect(result.drafts).toEqual([]);
  expect(readmeRequests).toEqual([]); // ni siquiera pidió el README
  expect(fs.readFileSync(snapshotPath(snapshotDir, LIST), 'utf8')).toBe(
    '{ esto no es json',
  );

  fs.writeFileSync(
    snapshotPath(snapshotDir, LIST),
    JSON.stringify({
      version: 1,
      repo: 'otro/awesome',
      etag: null,
      fetchedAt: 'x',
      links: [],
    }),
  );
  const mismatch = await collect();
  expect(mismatch.errors[0].message).toContain('es de otro/awesome');
});

test('writeAwesomeSnapshots con onlyMissing crea las que faltan y no toca las que existen', async () => {
  const result = await pass('current');
  const before = fs.readFileSync(snapshotPath(snapshotDir, LIST), 'utf8');

  // mismo contenido de lista pero otra versión: con onlyMissing no se escribe
  setReadme('2026-09-10');
  const again = await collect({ now: new Date('2026-10-08T12:00:00Z') });
  const written = await writeAwesomeSnapshots(finalizeSnapshots(again, []), {
    onlyMissing: true,
  });
  expect(written).toEqual([]);
  expect(fs.readFileSync(snapshotPath(snapshotDir, LIST), 'utf8')).toBe(before);

  fs.rmSync(snapshotPath(snapshotDir, LIST));
  const created = await writeAwesomeSnapshots(finalizeSnapshots(result, []), {
    onlyMissing: true,
  });
  expect(created).toEqual([snapshotPath(snapshotDir, LIST)]);
});

test('sin token aborta antes de la primera petición; un 401 aborta la recogida', async () => {
  setReadme('current');
  await expect(collect({ token: undefined })).rejects.toThrow(
    MissingTokenError,
  );
  expect(readmeRequests).toEqual([]);

  server.use(
    http.get('https://api.github.com/repos/:owner/:repo/readme', () =>
      HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
    ),
  );
  await expect(collect()).rejects.toThrow('GITHUB_TOKEN rechazado');
});

test('sin awesome_listas no hay nada que hacer: ni una petición', async () => {
  const none = parseInterestsYaml('version: 1\n');
  const result = await collect({ interests: none });
  expect(result.lists).toEqual([]);
  expect(result.stats.requests).toBe(0);
  expect(readmeRequests).toEqual([]);
});

test('el tope global por recogida reparte entre listas por orden; lo que no cabe queda pendiente y los orígenes se suman', async () => {
  const OTHER = 'brillout/awesome-react-components';
  const two = parseInterestsYaml(`
version: 1
categorias:
  nextjs-react: { nombre: Next, peso: 0.9 }
  frontend-bonito: { nombre: Frontends, peso: 0.9 }
awesome_listas:
  ${LIST}: nextjs-react
  ${OTHER}: frontend-bonito
`);
  // la segunda lista sirve el mismo README real bajo otro nombre: lo que se prueba es el reparto
  const both = async (
    version: string,
    over: Partial<Parameters<typeof collect>[0]> = {},
  ) => {
    setReadme(version);
    setReadme(version, OTHER);
    const result = await collect({ interests: two, ...over });
    await writeAwesomeSnapshots(finalizeSnapshots(result, []));
    return result;
  };
  await both('2026-01-30');
  repoCalls = [];

  const result = await both('current', { maxNewPerRun: 10 });

  expect(result.lists.map((l) => [l.repo, l.resueltos, l.pendientes])).toEqual([
    [LIST, 8, 0],
    [OTHER, 2, 6],
  ]);
  // 10 resoluciones y no 16, y los 8 repos distintos llevan el origen de cada lista que los resolvió
  expect(repoCalls).toHaveLength(10);
  expect(result.repos).toHaveLength(8);
  const twice = result.repos.filter((r) => r.origins.length === 2);
  expect(twice).toHaveLength(2);
  expect(twice[0].origins.map((o) => o.categoria)).toEqual([
    'nextjs-react',
    'frontend-bonito',
  ]);
  expect(result.stats).toMatchObject({
    nuevos: 16,
    resueltos: 10,
    pendientes: 6,
  });

  // la semana siguiente la segunda lista recupera lo que le faltó
  repoCalls = [];
  const next = await both('current', { maxNewPerRun: 10 });
  expect(next.lists.map((l) => [l.repo, l.nuevos, l.resueltos])).toEqual([
    [LIST, 0, 0], // sin ETag no, pero la instantánea ya lo tiene todo: nada nuevo
    [OTHER, 6, 6],
  ]);
});
