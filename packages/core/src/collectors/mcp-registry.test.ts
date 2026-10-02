import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'vitest';
import {
  mcpFixtures,
  mcpHandlers,
  newMcpState,
} from '../testing/mcp-registry.js';
import { MissingTokenError } from './github-client.js';
import { toGithubRepo } from './github-graphql.js';
import {
  MAX_PENDING,
  type McpRegistryResult,
  type McpRegistryState,
  REGISTRY_ID,
  collectFromMcpRegistry,
  finalizeMcpRegistryState,
  githubRepoOf,
  mcpRegistryStatePath,
  registryNote,
  writeMcpRegistryState,
} from './mcp-registry.js';

// Todo lo que sirve el servidor son respuestas reales grabadas el 2026-10-02 (ver
// `testing/mcp-registry.ts`): 246 servidores del registro en 3 páginas y los objetos GraphQL
// de sus 164 repos de GitHub (7 ya no existen, 4 se renombraron).
const { rows, graphqlObjects, versions, notFound } = mcpFixtures;
const META = 'io.modelcontextprotocol.registry/official';
const statusOf = (row: (typeof rows)[number]) =>
  row._meta?.[META]?.status ?? 'active';

// Lo que hay en los datos, medido con código independiente del colector.
const URL_RE =
  /^https:\/\/github\.com\/([\w-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i;
const active = rows.filter((r) => statusOf(r) === 'active');
const github = active.filter(
  (r) =>
    r.server.repository?.source === 'github' &&
    URL_RE.test(r.server.repository.url ?? ''),
);
const repoKey = (r: (typeof rows)[number]) => {
  const m = URL_RE.exec(r.server.repository?.url ?? '') as RegExpExecArray;
  return `${m[1]}/${m[2]}`.toLowerCase();
};
const byRepo = new Map<string, typeof rows>();
for (const r of github)
  byRepo.set(repoKey(r), [...(byRepo.get(repoKey(r)) ?? []), r]);
const withPackages = (k: string) =>
  (byRepo.get(k) ?? []).some((r) => r.server.packages?.length);
const starsOf = (k: string) => graphqlObjects[k]?.stargazerCount;
const MIN = 30;
const EXISTING = [...byRepo.keys()].filter((k) => graphqlObjects[k]);
const PASSING = EXISTING.filter((k) => (starsOf(k) ?? 0) >= MIN);

const state = newMcpState();
const server = setupServer(...mcpHandlers(state));

const NOW = new Date(Date.parse(versions.recordedAt));
let stateDir: string;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-mcp-'));
  state.registryRequests = [];
  state.graphqlRequests = [];
  state.registryMode = 'ok';
  state.graphqlFailFor.clear();
  state.graphqlUnauthorized = false;
  state.flakyServed = 0;
});
afterEach(() => {
  server.resetHandlers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const collect = (
  over: Partial<Parameters<typeof collectFromMcpRegistry>[0]> = {},
) =>
  collectFromMcpRegistry({
    token: 'test-token',
    now: NOW,
    stateDir,
    categoria: 'mcp-servers',
    minStars: MIN,
    throttle: false,
    retryBaseMs: 1,
    ...over,
  });
/** El estado de hace cuatro horas: lo que el colector dejó la última vez. */
const put = (over: Partial<McpRegistryState> = {}) => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    mcpRegistryStatePath(stateDir),
    JSON.stringify({
      version: 1,
      repo: REGISTRY_ID,
      syncedAt: versions.since,
      pending: [],
      ...over,
    }),
  );
};
const readState = (): McpRegistryState =>
  JSON.parse(fs.readFileSync(mcpRegistryStatePath(stateDir), 'utf8'));
const pass = async (
  over: Partial<Parameters<typeof collectFromMcpRegistry>[0]> = {},
  deferred: string[] = [],
): Promise<McpRegistryResult> => {
  const result = await collect(over);
  await writeMcpRegistryState(finalizeMcpRegistryState(result, deferred));
  return result;
};
const lookups = () => state.graphqlRequests.filter((r) => !r.full);
const details = () => state.graphqlRequests.filter((r) => r.full);

test('los datos reales: 246 servidores, 238 activos (7 deprecated y 1 deleted fuera), 164 repos de GitHub distintos', () => {
  expect(rows).toHaveLength(246);
  expect(versions.pages).toBe(3);
  expect(active).toHaveLength(238);
  expect(github).toHaveLength(166);
  expect(byRepo.size).toBe(164); // dos repos publican dos servidores
  expect(EXISTING).toHaveLength(157);
  expect(notFound).toHaveLength(7);
  expect(PASSING).toHaveLength(24);
});

test('githubRepoOf: solo repos de GitHub; GitLab, sin repositorio o URL rara no cuentan', () => {
  const entry = (repository?: { url?: string; source?: string }) =>
    ({ server: { name: 'x/y', repository }, _meta: {} }) as never;
  expect(
    githubRepoOf(
      entry({ url: 'https://github.com/Foo/Bar', source: 'github' }),
    ),
  ).toBe('Foo/Bar');
  expect(
    githubRepoOf(
      entry({ url: 'https://github.com/foo/bar.git', source: 'github' }),
    ),
  ).toBe('foo/bar');
  expect(
    githubRepoOf(
      entry({
        url: 'https://github.com/foo/bar/tree/main/sub',
        source: 'github',
      }),
    ),
  ).toBe('foo/bar');
  expect(
    githubRepoOf(
      entry({ url: 'https://gitlab.com/foo/bar', source: 'gitlab' }),
    ),
  ).toBeNull();
  expect(
    githubRepoOf(entry({ url: 'https://github.com/foo', source: 'github' })),
  ).toBeNull();
  expect(githubRepoOf(entry(undefined))).toBeNull();
  // y con los datos reales coincide con la medición independiente
  expect(
    rows
      .filter((r) => statusOf(r) === 'active')
      .map(githubRepoOf)
      .filter(Boolean),
  ).toHaveLength(github.length);
});

test('registryNote: el manifiesto resumido (paquetes y remotos), con los repos de varios servidores', () => {
  const bowmark = byRepo.get('bowmark-ai/skill')?.[0] as (typeof rows)[number];
  expect(
    registryNote([
      {
        name: bowmark.server.name,
        version: bowmark.server.version ?? '',
        packages: (bowmark.server.packages ?? []).map(
          (p) => `${p.registryType}:${p.identifier}`,
        ),
        remotes: (bowmark.server.remotes ?? []).map((r) => r.type ?? ''),
      },
    ]),
  ).toBe(
    'Registro MCP: ai.bowmark/bowmark 8.153.1 · paquetes: pypi:bowmark-mcp, npm:@bowmark/mcp · remotos: streamable-http',
  );
  const two = registryNote([
    { name: 'a/uno', version: '1.0.0', packages: [], remotes: [] },
    { name: 'a/dos', version: '2.0.0', packages: ['npm:x'], remotes: ['sse'] },
  ]);
  expect(two).toBe(
    'Registro MCP: a/uno 1.0.0 (+1 servidores más del mismo repo) · paquetes: npm:x · remotos: sse',
  );
  expect(
    registryNote([
      { name: 'a'.repeat(400), version: '1', packages: [], remotes: [] },
    ]).length,
  ).toBe(280);
});

test('primera pasada: una sola petición al registro (comprueba que responde), nada de GitHub y solo se anota la hora', async () => {
  const result = await pass();

  expect(state.registryRequests).toHaveLength(1);
  expect(state.registryRequests[0].params).toEqual({
    version: 'latest',
    limit: '1',
  });
  expect(state.graphqlRequests).toEqual([]);
  expect(result.report).toMatchObject({
    estado: 'primera-pasada',
    paginas: 0,
    filas: 0,
  });
  expect(result.repos).toEqual([]);
  expect(readState()).toEqual({
    version: 1,
    repo: REGISTRY_ID,
    syncedAt: NOW.toISOString(),
    pending: [],
  });
  expect(path.basename(mcpRegistryStatePath(stateDir))).toBe(
    'registry.modelcontextprotocol.io.json',
  );
});

test('el diff real de 4 horas: páginas, filtro de estado, repos distintos, etapa 1 de estrellas y etapa 2 de detalle', async () => {
  put();

  const result = await collect();

  // — el registro: tres páginas con la ventana y los parámetros pedidos, encadenadas por su cursor —
  expect(state.registryRequests.map((r) => r.params.cursor)).toEqual([
    undefined,
    mcpFixtures.pages[0].metadata?.nextCursor,
    mcpFixtures.pages[1].metadata?.nextCursor,
  ]);
  for (const r of state.registryRequests) {
    expect(r.params).toMatchObject({
      version: 'latest',
      updated_since: versions.since,
      limit: '100',
    });
  }
  expect(result.report).toMatchObject({
    estado: 'con-cambios',
    paginas: 3,
    filas: 246,
    activos: 238,
    conGithub: 166,
    repos: 164,
    truncado: false,
    ventanaAcotada: false,
  });

  // — etapa 1: estrellas de los 164 en lotes de 25 (7 consultas), solo `nameWithOwner stargazerCount` —
  expect(lookups()).toHaveLength(Math.ceil(164 / 25));
  expect(lookups().every((r) => r.names.length <= 25)).toBe(true);
  expect(
    lookups()
      .flatMap((r) => r.names)
      .map((n) => n.toLowerCase())
      .sort(),
  ).toEqual([...byRepo.keys()].sort());
  expect(result.report).toMatchObject({
    consultados: 164,
    desaparecidos: 7,
    omitidos: 0,
  });

  // — etapa 2: detalle completo solo de los que llegan a 30★ (en una consulta) —
  expect(result.report.conEstrellas).toBe(24);
  expect(details()).toHaveLength(1);
  expect(
    details()[0]
      .names.map((n) => n.toLowerCase())
      .sort(),
  ).toEqual([...PASSING].sort());
  expect(result.report).toMatchObject({ detallados: 24, pendientes: 0 });
  expect(result.stats).toMatchObject({ requests: 3, lotes: 8, puntos: 8 });

  // — los candidatos: GithubRepo con la forma REST, origen `registry` y el manifiesto en las notas —
  expect(result.repos).toHaveLength(24);
  const sem = result.repos.find((r) => r.repo.full_name === 'Ataraxy-Labs/sem');
  expect(sem?.repo).toMatchObject({
    full_name: 'Ataraxy-Labs/sem',
    stargazers_count: 3369,
    html_url: 'https://github.com/Ataraxy-Labs/sem',
  });
  expect(sem?.repo).toEqual(toGithubRepo(graphqlObjects['ataraxy-labs/sem']));
  expect(sem?.origins).toEqual([
    {
      categoria: 'mcp-servers',
      tipo: 'registry',
      query: expect.stringContaining('/'),
    },
  ]);
  expect(sem?.notes[0]).toMatch(/^Registro MCP: .+ · (paquetes|remotos): /);
  // los 4 renombrados salen con el nombre vigente de GitHub, no con el del registro
  expect(
    result.repos.filter(
      (r) =>
        r.repo.full_name.toLowerCase() !==
        r.repo.full_name.toLowerCase().trim(),
    ),
  ).toEqual([]);
  expect(draftState(result)).toMatchObject({
    syncedAt: NOW.toISOString(),
    pending: [],
  });
});

test('lo que se pide primero a GitHub: los repos que publican paquetes, antes que los solo remotos', async () => {
  put();

  await collect({ maxStarsLookups: 30 });

  const asked = lookups()
    .flatMap((r) => r.names)
    .map((n) => n.toLowerCase());
  expect(asked).toHaveLength(30);
  // con 120 repos con paquetes, los 30 que entran en el tope lo son todos
  expect(asked.every(withPackages)).toBe(true);
  // y dentro de ellos, los publicados más recientemente primero
  const published = (k: string) =>
    (byRepo.get(k) ?? [])
      .map((r) => r._meta?.[META]?.publishedAt ?? '')
      .sort()
      .at(-1) ?? '';
  const times = asked.map(published);
  expect([...times].sort().reverse()).toEqual(times);
});

test('el tope de consultas de estrellas deja fuera lo nuevo sin arrastrarlo (el registro es un caudal), pero conserva los pendientes', async () => {
  put({
    pending: [
      {
        repo: 'Ataraxy-Labs/sem',
        nota: 'Registro MCP: guardada la semana anterior',
      },
    ],
  });

  const result = await collect({ maxStarsLookups: 5 });

  const asked = lookups()
    .flatMap((r) => r.names)
    .map((n) => n.toLowerCase());
  expect(asked).toHaveLength(5);
  expect(asked[0]).toBe('ataraxy-labs/sem'); // el pendiente va el primero
  expect(result.report).toMatchObject({ consultados: 5, omitidos: 164 - 5 });
  // lo omitido no se guarda: no se arrastran miles de repos
  expect(draftState(result).pending).toEqual([]);
});

test('el tope de detalles deja el resto pendiente con su nota, y la semana siguiente los pendientes salen primero con su origen y su nota', async () => {
  put();

  const first = await pass({ maxDetails: 5 });

  expect(first.report).toMatchObject({
    conEstrellas: 24,
    detallados: 5,
    pendientes: 19,
  });
  expect(first.repos).toHaveLength(5);
  const saved = readState().pending;
  expect(saved).toHaveLength(19);
  expect(saved.every((p) => p.nota.startsWith('Registro MCP: '))).toBe(true);
  expect(new Set(saved.map((p) => p.repo.toLowerCase()))).toEqual(
    new Set(
      PASSING.filter(
        (k) => !first.repos.some((r) => r.repo.full_name.toLowerCase() === k),
      ),
    ),
  );

  // la semana siguiente el registro no trae nada nuevo: solo se procesan los pendientes
  state.registryMode = 'empty';
  state.graphqlRequests = [];
  const second = await pass({ maxDetails: 100 });
  expect(second.report).toMatchObject({
    filas: 0,
    consultados: 19,
    conEstrellas: 19,
    detallados: 19,
    pendientes: 0,
  });
  expect(second.repos).toHaveLength(19);
  for (const r of second.repos) {
    expect(r.origins).toEqual([
      { categoria: 'mcp-servers', tipo: 'registry', query: REGISTRY_ID },
    ]);
    expect(r.notes[0]).toMatch(/^Registro MCP: /);
  }
  expect(readState().pending).toEqual([]);
});

test('un fallo transitorio de GitHub (504) deja ese lote pendiente y el resto sigue', async () => {
  put();
  const target = [...byRepo.keys()].filter(withPackages)[0];
  state.graphqlFailFor.add(target);

  const result = await pass();

  // el lote que contenía ese repo (hasta 25) quedó pendiente y no cuenta como consultado
  expect(result.report.consultados).toBeLessThan(164);
  expect(result.report.consultados).toBeGreaterThanOrEqual(164 - 25);
  const pendiente = readState().pending.map((p) => p.repo.toLowerCase());
  expect(pendiente).toContain(target);
  expect(pendiente.length).toBe(164 - result.report.consultados);
  expect(result.errors).toEqual([]); // algo funcionó: no es un error de la fuente
});

test('si ninguna consulta a GitHub funciona queda anotado, los repos vuelven y el estado sí avanza', async () => {
  put();
  for (const k of byRepo.keys()) state.graphqlFailFor.add(k);

  const result = await pass();

  expect(result.report.consultados).toBe(0);
  expect(result.errors).toEqual([
    {
      source: 'mcp-registry',
      query: REGISTRY_ID,
      message: expect.stringContaining('Ninguna consulta GraphQL'),
    },
  ]);
  expect(readState().pending).toHaveLength(byRepo.size); // los 164 vuelven
  expect(readState().syncedAt).toBe(NOW.toISOString());
});

test('si el registro cae, no se avanza el estado y la semana siguiente se vuelve a leer todo', async () => {
  put();
  const before = fs.readFileSync(mcpRegistryStatePath(stateDir), 'utf8');
  state.registryMode = 'down';

  const result = await pass();

  expect(result.report.estado).toBe('error');
  expect(result.errors[0]).toMatchObject({
    source: 'mcp-registry',
    message: 'HTTP 503',
  });
  expect(result.drafts).toEqual([]);
  expect(state.registryRequests).toHaveLength(3); // el intento y dos reintentos
  expect(state.graphqlRequests).toEqual([]);
  expect(fs.readFileSync(mcpRegistryStatePath(stateDir), 'utf8')).toBe(before);
});

test('un 500 aislado del registro se reintenta y la recogida sigue', async () => {
  put();
  state.registryMode = 'flaky';

  const result = await collect();

  expect(result.report).toMatchObject({
    estado: 'con-cambios',
    paginas: 3,
    filas: 246,
  });
  expect(state.registryRequests).toHaveLength(4); // 1 fallida + 3 páginas
});

test('si hace más de 14 días de la última lectura se mira solo ese tramo y se dice', async () => {
  put({ syncedAt: new Date(NOW.getTime() - 30 * 24 * 3600e3).toISOString() });

  const result = await collect({ maxPages: 1 });

  expect(state.registryRequests[0].params.updated_since).toBe(
    new Date(NOW.getTime() - 14 * 24 * 3600e3).toISOString(),
  );
  expect(result.report.ventanaAcotada).toBe(true);
});

test('el tope de páginas corta el listado, lo anota y no se pierde el aviso', async () => {
  put();

  const result = await collect({ maxPages: 2 });

  expect(result.report).toMatchObject({
    paginas: 2,
    filas: 200,
    truncado: true,
  });
  expect(result.errors).toEqual([
    {
      source: 'mcp-registry',
      query: REGISTRY_ID,
      message: expect.stringContaining('Listado cortado en 2 páginas'),
    },
  ]);
});

test('finalizeMcpRegistryState: lo que enrich_max difirió vuelve como pendiente (también si el repo se renombró) y el máximo se respeta', async () => {
  put();
  const result = await collect();
  // el registro lo llama `antonbaider/remcp` y GitHub `getremcp/remcp`
  const renamed = result.repos.find(
    (r) => r.repo.full_name === 'getremcp/remcp',
  );
  const deferred = ['ataraxy-labs/sem', ...(renamed ? ['getremcp/remcp'] : [])];

  const [write] = finalizeMcpRegistryState(result, deferred);

  const keys = write.snapshot.pending.map((p) => p.repo.toLowerCase());
  expect(keys).toContain('ataraxy-labs/sem');
  if (renamed) expect(keys).toContain('antonbaider/remcp');
  expect(
    write.snapshot.pending.every((p) => p.nota.startsWith('Registro MCP: ')),
  ).toBe(true);
  expect(write.snapshot.pending.length).toBeLessThanOrEqual(MAX_PENDING);
  expect(write.snapshot.syncedAt).toBe(NOW.toISOString());
});

test('writeMcpRegistryState con onlyMissing crea el estado que falta y no toca el que existe', async () => {
  const first = await collect();
  const written = await writeMcpRegistryState(
    finalizeMcpRegistryState(first, []),
    { onlyMissing: true },
  );
  expect(written).toEqual([mcpRegistryStatePath(stateDir)]);
  const before = fs.readFileSync(mcpRegistryStatePath(stateDir), 'utf8');

  state.registryMode = 'ok';
  const later = await collect({
    now: new Date(NOW.getTime() + 7 * 24 * 3600e3),
  });
  const again = await writeMcpRegistryState(
    finalizeMcpRegistryState(later, []),
    { onlyMissing: true },
  );

  expect(again).toEqual([]);
  expect(fs.readFileSync(mcpRegistryStatePath(stateDir), 'utf8')).toBe(before);
});

test('un estado corrupto o de otra fuente no se sobrescribe: error y no se pide nada', async () => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(mcpRegistryStatePath(stateDir), '{ no es json');

  const result = await collect();

  expect(result.errors[0].message).toContain(
    'no es JSON válido; no se sobrescribe',
  );
  expect(result.drafts).toEqual([]);
  expect(state.registryRequests).toEqual([]);
  expect(fs.readFileSync(mcpRegistryStatePath(stateDir), 'utf8')).toBe(
    '{ no es json',
  );
});

test('sin token aborta antes de la primera petición; un 401 de GitHub aborta la recogida', async () => {
  put();
  await expect(collect({ token: undefined })).rejects.toThrow(
    MissingTokenError,
  );
  expect(state.registryRequests).toEqual([]);

  state.graphqlUnauthorized = true;
  await expect(collect()).rejects.toThrow();
});

/** El estado que se escribiría al terminar (borrador de la recogida). */
function draftState(result: McpRegistryResult): McpRegistryState {
  return finalizeMcpRegistryState(result, [])[0].snapshot;
}
