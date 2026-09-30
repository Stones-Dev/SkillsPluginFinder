import fs from 'node:fs';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { createGithubClient } from '../collectors/github-client.js';
import {
  README_EXCERPT_MAX,
  cleanReadme,
  contributorCount,
  enrichGithubRepo,
  fetchContributors,
  fetchLifecycleScripts,
  fetchReadme,
  lifecycleScripts,
} from './github.js';

const FIX = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/github-enrich',
);
const text = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');
type Recorded = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};
const recorded = (name: string) => JSON.parse(text(name)) as Recorded;

const RAW_HEADERS = {
  'content-type': 'application/vnd.github.raw+json; charset=utf-8',
};
const raw = (body: string) =>
  new HttpResponse(body, { status: 200, headers: RAW_HEADERS });
const replay = (name: string) => {
  const r = recorded(name);
  return new HttpResponse(JSON.stringify(r.body), {
    status: r.status,
    headers: r.headers,
  });
};

const API = 'https://api.github.com/repos';
let requests: Request[] = [];
const track = (request: Request) => requests.push(request);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  requests = [];
});
afterAll(() => server.close());

const { octokit } = createGithubClient({
  token: 'test-token',
  throttle: false,
  retryBaseMs: 1,
});

// Respuestas reales grabadas de alsk1992/CloddsBot (README con mucho HTML/badges,
// package.json con postinstall, 4 contribuidores).
const cloddsHandlers = () => [
  http.get(`${API}/alsk1992/CloddsBot/readme`, ({ request }) => {
    track(request);
    return raw(text('alsk1992__CloddsBot.readme.md'));
  }),
  http.get(`${API}/alsk1992/CloddsBot/contents/package.json`, ({ request }) => {
    track(request);
    return raw(text('alsk1992__CloddsBot.package.json'));
  }),
  http.get(`${API}/alsk1992/CloddsBot/contributors`, ({ request }) => {
    track(request);
    return replay('alsk1992__CloddsBot.contributors.json');
  }),
];

test('cleanReadme sobre un README real: sin HTML, badges ni imágenes y dentro del límite', () => {
  const source = text('alsk1992__CloddsBot.readme.md');
  expect(source).toMatch(/<img /); // el original sí está lleno de HTML
  expect(source.length).toBeGreaterThan(README_EXCERPT_MAX);

  const excerpt = cleanReadme(source);

  expect(excerpt.length).toBeLessThanOrEqual(README_EXCERPT_MAX);
  expect(excerpt).not.toMatch(/<\/?[a-z][^>]*>/i);
  expect(excerpt).not.toContain('![');
  expect(excerpt).not.toContain('<!--');
  expect(excerpt).toContain('AI-powered trading terminal');
  expect(excerpt.endsWith('…')).toBe(true);
});

test('cleanReadme conserva el texto corto y no parte pares sustitutos al recortar', () => {
  expect(cleanReadme('# Título\n\nTexto ñ — útil.')).toBe(
    '# Título\n\nTexto ñ — útil.',
  );
  expect(
    cleanReadme(
      '<!-- nota -->\n<p align="center">Hola</p>\n\n\n\n![b](https://x/y.svg)\nFin',
    ),
  ).toBe('Hola\n\nFin');

  const cut = cleanReadme(`${'a'.repeat(1998)}😀 resto del texto`);
  expect(cut.length).toBeLessThanOrEqual(README_EXCERPT_MAX);
  expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('lifecycleScripts detecta postinstall en el package.json real y nada en el que no lo tiene', () => {
  expect(
    lifecycleScripts(JSON.parse(text('alsk1992__CloddsBot.package.json'))),
  ).toEqual(['postinstall']);
  expect(
    lifecycleScripts(
      JSON.parse(text('solana-foundation__solana-web3.js.package.json')),
    ),
  ).toEqual([]);
  expect(
    lifecycleScripts({
      scripts: { install: 'x', preinstall: 'y', prepare: 'z', test: 't' },
    }),
  ).toEqual(['preinstall', 'install']);
  expect(lifecycleScripts(null)).toEqual([]);
  expect(lifecycleScripts({})).toEqual([]);
});

test('contributorCount lee la última página del Link real (per_page=1) o cuenta los elementos', () => {
  const clodds = recorded('alsk1992__CloddsBot.contributors.json');
  expect(contributorCount(clodds.headers.link, 1)).toBe(4);

  const single = recorded('ChrisWiles__claude-code-showcase.contributors.json');
  expect(single.headers.link).toBeUndefined();
  expect(
    contributorCount(single.headers.link, (single.body as unknown[]).length),
  ).toBe(1);
});

test('fetchReadme, fetchContributors y fetchLifecycleScripts contra las respuestas reales grabadas', async () => {
  server.use(...cloddsHandlers());

  expect(await fetchReadme(octokit, 'alsk1992', 'CloddsBot')).toBe(
    text('alsk1992__CloddsBot.readme.md'),
  );
  expect(await fetchContributors(octokit, 'alsk1992', 'CloddsBot')).toBe(4);
  expect(await fetchLifecycleScripts(octokit, 'alsk1992', 'CloddsBot')).toEqual(
    ['postinstall'],
  );

  const accepts = requests.map((r) => r.headers.get('accept'));
  expect(accepts[0]).toContain('raw');
  expect(new URL(requests[1].url).searchParams.get('per_page')).toBe('1');
});

test('un repo sin package.json en la raíz devuelve null (404 real grabado)', async () => {
  server.use(
    http.get(`${API}/coreyhaines31/marketingskills/contents/package.json`, () =>
      replay('coreyhaines31__marketingskills.package.json.404.json'),
    ),
    http.get(
      `${API}/solana-foundation/solana-web3.js/contents/package.json`,
      () => raw(text('solana-foundation__solana-web3.js.package.json')),
    ),
  );

  expect(
    await fetchLifecycleScripts(octokit, 'coreyhaines31', 'marketingskills'),
  ).toBeNull();
  expect(
    await fetchLifecycleScripts(octokit, 'solana-foundation', 'solana-web3.js'),
  ).toEqual([]);
});

test('enrichGithubRepo reúne README limpio, contribuidores y scripts de instalación', async () => {
  server.use(...cloddsHandlers());
  const e = await enrichGithubRepo(octokit, 'alsk1992/CloddsBot');

  expect(e.notes).toEqual([]);
  expect(e.contributors).toBe(4);
  expect(e.singleMaintainer).toBe(false);
  expect(e.lifecycleScripts).toEqual(['postinstall']);
  expect(e.readmeExcerpt).toContain('AI-powered trading terminal');
  expect(e.readmeExcerpt?.length).toBeLessThanOrEqual(README_EXCERPT_MAX);
});

test('un fallo puntual no tumba el enriquecimiento: queda anotado en notes', async () => {
  server.use(
    http.get(`${API}/coreyhaines31/marketingskills/readme`, () =>
      HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
    ),
    http.get(`${API}/coreyhaines31/marketingskills/contributors`, () =>
      HttpResponse.json({ message: 'Server Error' }, { status: 500 }),
    ),
    http.get(`${API}/coreyhaines31/marketingskills/contents/package.json`, () =>
      replay('coreyhaines31__marketingskills.package.json.404.json'),
    ),
  );
  const e = await enrichGithubRepo(octokit, 'coreyhaines31/marketingskills');

  expect(e).toMatchObject({
    readmeExcerpt: null,
    contributors: null,
    singleMaintainer: null,
    lifecycleScripts: null,
  });
  expect(e.notes).toHaveLength(1);
  expect(e.notes[0]).toMatch(/^Contribuidores no disponible/);
});

test('un 401 durante el enriquecimiento se propaga', async () => {
  server.use(
    http.get(`${API}/x/y/readme`, () =>
      HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
    ),
  );

  await expect(enrichGithubRepo(octokit, 'x/y')).rejects.toMatchObject({
    status: 401,
  });
});
