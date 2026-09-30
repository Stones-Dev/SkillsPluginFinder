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
import { interestsSchema } from '../config/schema.js';
import { extractYamlBlock } from '../vault/markdown.js';
import {
  buildQueries,
  collectFromGithub,
  sinceDate,
  starsQualifier,
} from './github.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const searchFixture = JSON.parse(
  fs.readFileSync(path.join(fixtures, 'github-search/response.json'), 'utf8'),
);
const realInterests = parseInterestsYaml(
  extractYamlBlock(
    fs
      .readFileSync(path.join(fixtures, 'vault/Intereses.md'), 'utf8')
      .replace(/\r\n/g, '\n'),
  ).body,
  'Intereses.md',
);

const NOW = new Date('2026-09-30T12:00:00Z'); // ventana de 14 días => 2026-09-16

const interests = interestsSchema.parse({
  ventana_dias: 14,
  reglas_globales: { estrellas_min: 50 },
  categorias: {
    'claude-skills': {
      nombre: 'Claude',
      peso: 1,
      estrellas_min: 20,
      keywords: ['claude code skill', 'SKILL.md'],
      topics: ['claude-code'],
    },
    'agent-skills': {
      nombre: 'Agent',
      peso: 0.8,
      estrellas_min: 20,
      keywords: ['SKILL.md'],
    },
    rust: { nombre: 'Rust', peso: 0.7, keywords: ['tokio'], topics: ['rust'] },
  },
});

const oneQuery = interestsSchema.parse({
  categorias: { c: { nombre: 'C', peso: 1, keywords: ['tokio'] } },
});

const EXPECTED_Q = [
  '"claude code skill" created:>2026-09-16 stars:>=20',
  '"SKILL.md" created:>2026-09-16 stars:>=20',
  'topic:claude-code pushed:>2026-09-16 stars:>=20',
  '"tokio" created:>2026-09-16 stars:>=50',
  'topic:rust pushed:>2026-09-16 stars:>=50',
];

let requests: Request[] = [];
const server = setupServer();
const respondSearch = ({ request }: { request: Request }) => {
  requests.push(request);
  return HttpResponse.json(searchFixture);
};
const searchHandler = (resolver = respondSearch) =>
  http.get('https://api.github.com/search/repositories', resolver);
const queryOf = (r: Request) => new URL(r.url).searchParams.get('q');

const options = {
  token: 'test-token',
  interests,
  now: NOW,
  throttle: false,
  retryBaseMs: 1,
};

let tmp: string;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-gh-'));
});
afterEach(() => {
  server.resetHandlers();
  requests = [];
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => server.close());

test('sinceDate resta la ventana en días (UTC)', () => {
  expect(sinceDate(NOW, 14)).toBe('2026-09-16');
  expect(sinceDate(new Date('2026-03-05T00:30:00Z'), 7)).toBe('2026-02-26');
});

test('buildQueries: keyword con created:>, topic con pushed:>, stars mínimas y consultas comunes fusionadas', () => {
  const queries = buildQueries(interests, NOW);

  expect(queries.map((q) => q.q)).toEqual(EXPECTED_Q);
  expect(queries[1].origins).toEqual([
    { categoria: 'claude-skills', tipo: 'keyword', query: 'SKILL.md' },
    { categoria: 'agent-skills', tipo: 'keyword', query: 'SKILL.md' },
  ]);
  expect(queries[2].origins).toEqual([
    { categoria: 'claude-skills', tipo: 'topic', query: 'claude-code' },
  ]);
});

test('starsQualifier: >=MIN sin techo y MIN..MAX con él', () => {
  expect(starsQualifier(50, undefined)).toBe('>=50');
  expect(starsQualifier(50, 20000)).toBe('50..20000');
});

test('buildQueries con estrellas_max: cada consulta lleva el rango MIN..MAX de su categoría', () => {
  const capped = interestsSchema.parse({
    ventana_dias: 14,
    reglas_globales: { estrellas_min: 50, estrellas_max: 20000 },
    categorias: { ...interests.categorias },
  });
  const queries = buildQueries(capped, NOW).map((q) => q.q);

  expect(queries).toEqual([
    '"claude code skill" created:>2026-09-16 stars:20..20000',
    '"SKILL.md" created:>2026-09-16 stars:20..20000',
    'topic:claude-code pushed:>2026-09-16 stars:20..20000',
    '"tokio" created:>2026-09-16 stars:50..20000',
    'topic:rust pushed:>2026-09-16 stars:50..20000',
  ]);
});

test('buildQueries con Intereses.md real: 110 consultas declaradas, 109 únicas, todas con rango', () => {
  const queries = buildQueries(realInterests, NOW);

  // 70 keywords + 40 topics; "SKILL.md" (20..20000 estrellas) está en dos categorías.
  expect(queries).toHaveLength(109);
  const skillMd = queries.find((q) => q.q.startsWith('"SKILL.md"'));
  expect(skillMd?.origins.map((o) => o.categoria)).toEqual([
    'claude-skills',
    'agent-skills',
  ]);
  for (const { q } of queries) {
    expect(q).toMatch(
      /^("[^"]+" created:>2026-09-16|topic:[\w.-]+ pushed:>2026-09-16) stars:\d+\.\.20000$/,
    );
  }
  // estrellas_min propia (sage200: 5) frente a la global (rust: 50).
  expect(queries.find((q) => q.q.startsWith('"sage 200"'))?.q).toContain(
    'stars:5..20000',
  );
  expect(queries.find((q) => q.q.startsWith('"tokio"'))?.q).toContain(
    'stars:50..20000',
  );
});

test('los tests no pueden salir a la red real: sin handler la petición falla localmente', async () => {
  // Si una llamada llegara a api.github.com con este token falso, GitHub
  // respondería 401 y el colector abortaría con "GITHUB_TOKEN rechazado".
  // Bloqueada por msw, la consulta falla de forma aislada. (Una sola consulta:
  // msw imprime un aviso por intento, y hay 3 reintentos.)
  const result = await collectFromGithub({ ...options, interests: oneQuery });

  expect(result.repos).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].message).not.toContain('401');
  expect(result.errors[0].message).not.toContain('Bad credentials');
});

test('sin GITHUB_TOKEN aborta antes de la primera petición', async () => {
  server.use(searchHandler());

  for (const token of [undefined, '', '   ']) {
    const failure = collectFromGithub({ ...options, token });
    await expect(failure).rejects.toThrow('GITHUB_TOKEN es obligatorio');
    await expect(failure).rejects.toThrow('personal-access-tokens');
  }
  expect(requests).toHaveLength(0);
});

test('envía token, User-Agent identificado y los parámetros de búsqueda', async () => {
  server.use(searchHandler());
  await collectFromGithub(options);

  expect(requests.map(queryOf)).toEqual(EXPECTED_Q);
  for (const r of requests) {
    const params = new URL(r.url).searchParams;
    expect(r.headers.get('authorization')).toBe('token test-token');
    expect(r.headers.get('user-agent')).toMatch(
      /^SkillsPluginFinder\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/Stones-Dev\/SkillsPluginFinder\)/,
    );
    expect(params.get('sort')).toBe('stars');
    expect(params.get('order')).toBe('desc');
    expect(params.get('per_page')).toBe('30');
  }
});

test('fusiona los repos repetidos entre consultas y acumula sus orígenes', async () => {
  server.use(searchHandler());
  const result = await collectFromGithub(options);

  expect(result.stats).toMatchObject({
    queries: 5,
    executed: 5,
    requests: 5,
    cacheHits: 0,
    rawItems: 150,
    uniqueRepos: 30,
  });
  expect(result.errors).toEqual([]);
  expect(result.repos).toHaveLength(30);
  expect(result.repos[0].repo.full_name).toBe(searchFixture.items[0].full_name);
  // 5 consultas, una con dos categorías de origen => 6 orígenes por repo.
  expect(result.repos[0].origins).toHaveLength(6);
});

test('una consulta que falla (422) queda aislada en errors y el resto sigue', async () => {
  server.use(
    searchHandler(({ request }) => {
      requests.push(request);
      return queryOf(request)?.includes('tokio')
        ? HttpResponse.json(
            { message: 'Validation Failed', errors: [{ code: 'invalid' }] },
            { status: 422 },
          )
        : HttpResponse.json(searchFixture);
    }),
  );
  const result = await collectFromGithub(options);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatchObject({ source: 'github-search' });
  expect(result.errors[0].query).toContain('tokio');
  expect(result.errors[0].message).toContain('Validation Failed');
  expect(result.repos).toHaveLength(30);
  expect(result.stats.executed).toBe(5);
});

test('un 401 aborta la ejecución: el token inválido afecta a todas las consultas', async () => {
  server.use(
    searchHandler(({ request }) => {
      requests.push(request);
      return HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
    }),
  );

  await expect(collectFromGithub(options)).rejects.toThrow(
    'GITHUB_TOKEN rechazado por GitHub (401)',
  );
  expect(requests).toHaveLength(1);
});

test('reintenta ante un 5xx transitorio', async () => {
  let calls = 0;
  server.use(
    searchHandler(({ request }) => {
      requests.push(request);
      return ++calls === 1
        ? HttpResponse.json({ message: 'Bad gateway' }, { status: 502 })
        : HttpResponse.json(searchFixture);
    }),
  );
  const result = await collectFromGithub({ ...options, interests: oneQuery });

  expect(requests).toHaveLength(2);
  expect(result.errors).toEqual([]);
  expect(result.repos).toHaveLength(30);
});

test('caché de 24 h: la segunda ejecución no toca la red y una entrada caducada se vuelve a pedir', async () => {
  server.use(searchHandler());
  const cacheDir = path.join(tmp, 'cache');

  const first = await collectFromGithub({ ...options, cacheDir });
  expect(first.stats).toMatchObject({ requests: 5, cacheHits: 0 });
  expect(requests).toHaveLength(5);

  const second = await collectFromGithub({ ...options, cacheDir });
  expect(second.stats).toMatchObject({ requests: 0, cacheHits: 5 });
  expect(second.repos).toHaveLength(30);
  expect(requests).toHaveLength(5);

  const files = fs.readdirSync(cacheDir);
  expect(files).toHaveLength(5);
  for (const f of files) {
    const file = path.join(cacheDir, f);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(entry));
  }
  const third = await collectFromGithub({ ...options, cacheDir });
  expect(third.stats).toMatchObject({ requests: 5, cacheHits: 0 });
  expect(requests).toHaveLength(10);
});

test('respeta el timeout del colector y lo registra como error', async () => {
  server.use(searchHandler());
  const result = await collectFromGithub({ ...options, deadlineMs: -1 });

  expect(requests).toHaveLength(0);
  expect(result.repos).toEqual([]);
  expect(result.errors[0].message).toContain('Timeout del colector');
});

test('el throttling separa las búsquedas al menos 2 s (30 req/min)', async () => {
  server.use(searchHandler());
  const twoQueries = interestsSchema.parse({
    categorias: {
      c: { nombre: 'C', peso: 1, keywords: ['uno', 'dos'], estrellas_min: 1 },
    },
  });

  const started = Date.now();
  await collectFromGithub({
    ...options,
    interests: twoQueries,
    throttle: true,
  });

  expect(requests).toHaveLength(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
});
