import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  mcpFixtures,
  mcpHandlers,
  newMcpState,
} from '../testing/mcp-registry.js';
import { createGithubClient } from './github-client.js';
import {
  GRAPHQL_BATCH,
  REPO_FIELDS,
  STARS_FIELDS,
  buildBatchQuery,
  queryRepoBatch,
  toGithubRepo,
} from './github-graphql.js';

// Objetos y errores reales de la API GraphQL de GitHub (ver `testing/mcp-registry.ts`).
const { graphqlObjects, notFound } = mcpFixtures;
const state = newMcpState();
const server = setupServer(...mcpHandlers(state));
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  state.graphqlRequests = [];
  state.graphqlFailFor.clear();
  state.graphqlUnauthorized = false;
});
afterAll(() => server.close());

const client = () =>
  createGithubClient({ token: 't', throttle: false, retryBaseMs: 1 }).octokit;
const real = Object.keys(graphqlObjects).slice(0, 4);

test('buildBatchQuery: un alias por repo y los nombres raros no pueden colar nada en la consulta', () => {
  const query = buildBatchQuery(['foo/bar', 'baz/qux.js'], STARS_FIELDS);
  expect(query).toBe(
    'query { rateLimit { cost } r0: repository(owner: "foo", name: "bar") { nameWithOwner stargazerCount }\nr1: repository(owner: "baz", name: "qux.js") { nameWithOwner stargazerCount } }',
  );
  for (const bad of [
    'a"b/c',
    'foo/bar} { viewer { login',
    'foo',
    'a/b/c',
    '/x',
    'x/',
  ]) {
    expect(() => buildBatchQuery([bad], REPO_FIELDS), bad).toThrow(
      'Nombre de repo no válido',
    );
  }
  expect(GRAPHQL_BATCH).toBe(25);
});

test('toGithubRepo: un repo real de GraphQL con la forma REST que usa el pipeline', () => {
  const raw = graphqlObjects['ataraxy-labs/sem'];
  const repo = toGithubRepo(raw);
  expect(repo).toMatchObject({
    id: raw.databaseId,
    name: 'sem',
    full_name: 'Ataraxy-Labs/sem',
    html_url: 'https://github.com/Ataraxy-Labs/sem',
    stargazers_count: raw.stargazerCount,
    forks_count: raw.forkCount,
    created_at: raw.createdAt,
    pushed_at: raw.pushedAt,
    archived: false,
    fork: false,
    owner: { login: 'Ataraxy-Labs' },
  });
  expect(repo.license).toEqual(
    raw.licenseInfo
      ? {
          key: raw.licenseInfo.key,
          name: raw.licenseInfo.name,
          spdx_id: raw.licenseInfo.spdxId,
        }
      : null,
  );
  expect(repo.topics).toEqual(
    (raw.repositoryTopics?.nodes ?? []).map((n) => n.topic.name),
  );
  // sin licencia, sin lenguaje, sin push (repo vacío) y sin rama por defecto
  const bare = toGithubRepo({
    ...raw,
    licenseInfo: null,
    primaryLanguage: null,
    pushedAt: null,
    defaultBranchRef: null,
    description: null,
  });
  expect(bare).toMatchObject({
    license: null,
    language: null,
    pushed_at: raw.createdAt,
    default_branch: 'main',
    description: null,
  });
});

test('queryRepoBatch: los que existen, los que no (NOT_FOUND real) y el coste en puntos', async () => {
  const names = [...real, notFound[0]];

  const res = await queryRepoBatch(client(), names, STARS_FIELDS);

  expect(res.cost).toBe(1);
  expect(res.failed).toEqual([]);
  for (const name of real) {
    expect(res.repos.get(name.toLowerCase())?.nameWithOwner.toLowerCase()).toBe(
      name,
    );
    expect(res.repos.get(name.toLowerCase())?.stargazerCount).toBe(
      graphqlObjects[name].stargazerCount,
    );
  }
  expect(res.repos.get(notFound[0].toLowerCase())).toBeNull();
  // un lote sin ningún NOT_FOUND también funciona (octokit.graphql resuelve con el `data` directo)
  const clean = await queryRepoBatch(client(), real, STARS_FIELDS);
  expect([...clean.repos.values()].every((r) => r !== null)).toBe(true);
  expect(clean.failed).toEqual([]);
});

test('queryRepoBatch: un 504 deja el lote entero para reintentar; un 401 se relanza', async () => {
  state.graphqlFailFor.add(real[1]);
  const res = await queryRepoBatch(client(), real, STARS_FIELDS);
  expect(res.failed).toEqual(real);
  expect(res.repos.size).toBe(0);
  expect(res.cost).toBe(0);

  state.graphqlFailFor.clear();
  state.graphqlUnauthorized = true;
  await expect(queryRepoBatch(client(), real, STARS_FIELDS)).rejects.toThrow();
});

test('queryRepoBatch: un error que no es NOT_FOUND en un repo concreto lo deja para reintentar sin tirar el lote', async () => {
  server.use(
    http.post('https://api.github.com/graphql', () =>
      HttpResponse.json({
        data: { rateLimit: { cost: 1 }, r0: graphqlObjects[real[0]], r1: null },
        errors: [
          {
            type: 'FORBIDDEN',
            path: ['r1'],
            message: 'Resource not accessible',
          },
        ],
      }),
    ),
  );

  const res = await queryRepoBatch(client(), [real[0], real[1]], STARS_FIELDS);

  expect(res.repos.get(real[0])?.nameWithOwner.toLowerCase()).toBe(real[0]);
  expect(res.failed).toEqual([real[1]]);
});
