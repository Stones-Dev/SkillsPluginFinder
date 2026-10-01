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
import {
  anthropicFixtures,
  anthropicHandlers,
  newAnthropicState,
} from '../testing/anthropic.js';
import {
  type AnthropicResult,
  type AnthropicSnapshot,
  MARKETPLACE_REPO,
  SKILLS_REPO,
  anthropicSnapshotPath,
  collectFromAnthropic,
  finalizeAnthropicSnapshots,
  pluginDigest,
  pluginLocation,
  skillDescription,
  writeAnthropicSnapshots,
} from './anthropic.js';
import { MissingTokenError } from './github-client.js';

// Todo lo que sirve el servidor son respuestas reales de GitHub grabadas el 2026-10-01 (ver
// `tests/fixtures/anthropic/versions.json`): los commits y el listado de `skills/` de
// anthropics/skills en HEAD y en un commit del 2026-08-17, los `SKILL.md` de las skills que
// aparecen entre medias, el `marketplace.json` oficial en HEAD y del 2026-09-23, y los
// `GET /repos` de los plugins nuevos que viven en su propio repo.
const {
  versions,
  skillsCommits,
  skillsListing,
  marketplace,
  readText,
  NEW_PLUGINS,
  CHANGED_PLUGINS,
} = anthropicFixtures;
const state = newAnthropicState();
const server = setupServer(...anthropicHandlers(state));

const NOW = new Date('2026-10-01T12:00:00Z');
let snapshotDir: string;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-anthropic-'));
  state.requests = [];
  state.marketplaceMode = 'ok';
  state.repoStatus.clear();
});
afterEach(() => {
  server.resetHandlers();
  fs.rmSync(snapshotDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const collect = (
  over: Partial<Parameters<typeof collectFromAnthropic>[0]> = {},
) =>
  collectFromAnthropic({
    token: 'test-token',
    now: NOW,
    snapshotDir,
    categoria: 'claude-skills',
    throttle: false,
    retryBaseMs: 1,
    ...over,
  });

/** La instantánea de hace unas semanas, construida con los datos reales de entonces. */
const skillsBefore = (): AnthropicSnapshot => ({
  version: 1,
  repo: SKILLS_REPO,
  etag: 'W/"viejo"',
  head: versions.skills.oldHead,
  fetchedAt: '2026-08-17T12:00:00.000Z',
  items: Object.fromEntries(
    skillsListing.old
      .filter((i) => i.type === 'dir')
      .map((i) => [i.name, i.sha]),
  ),
});
const pluginsBefore = (): AnthropicSnapshot => ({
  version: 1,
  repo: MARKETPLACE_REPO,
  etag: 'W/"viejo"',
  head: versions.plugins.oldHead,
  fetchedAt: '2026-09-23T12:00:00.000Z',
  items: Object.fromEntries(
    marketplace.old.plugins.map((p) => [p.name, pluginDigest(p)]),
  ),
});
const put = (snapshot: AnthropicSnapshot) => {
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    anthropicSnapshotPath(snapshotDir, snapshot.repo),
    JSON.stringify(snapshot),
  );
};
const readSnapshot = (repo: string): AnthropicSnapshot =>
  JSON.parse(fs.readFileSync(anthropicSnapshotPath(snapshotDir, repo), 'utf8'));
const pass = async (
  over: Partial<Parameters<typeof collectFromAnthropic>[0]> = {},
  deferred: string[] = [],
): Promise<AnthropicResult> => {
  const result = await collect(over);
  await writeAnthropicSnapshots(finalizeAnthropicSnapshots(result, deferred));
  return result;
};
const source = (r: AnthropicResult, repo: string) =>
  r.sources.find((s) => s.repo === repo);
const gets = (re: RegExp) => state.requests.filter((r) => re.test(r.url));

test('pluginDigest ignora source.sha y source.ref pero no la descripción ni el origen', () => {
  const entry = marketplace.head.plugins.find((p) => p.name === 'linq-alpha');
  expect(entry?.source).toMatchObject({ source: 'git-subdir', ref: 'main' });
  const repinned = structuredClone(entry) as typeof entry & {
    source: Record<string, unknown>;
  };
  (repinned.source as Record<string, unknown>).sha = 'f'.repeat(40);
  (repinned.source as Record<string, unknown>).ref = 'v9.9.9';
  expect(pluginDigest(repinned)).toBe(pluginDigest(entry));

  const edited = { ...structuredClone(entry), description: 'otra cosa' };
  expect(pluginDigest(edited)).not.toBe(pluginDigest(entry));
  const moved = structuredClone(entry) as typeof repinned;
  (moved.source as Record<string, unknown>).url =
    'https://github.com/otro/repo.git';
  expect(pluginDigest(moved)).not.toBe(pluginDigest(entry));
  // el orden de las claves no cuenta
  expect(pluginDigest({ b: 1, a: { d: 1, c: 2 } })).toBe(
    pluginDigest({ a: { c: 2, d: 1 }, b: 1 }),
  );
});

test('con los dos marketplace reales, los pines mueven 6 plugins y la huella solo los 3 que cambian de verdad', () => {
  // con pines: el JSON completo de la entrada, claves ordenadas
  const full = (p: unknown) => JSON.stringify(sortKeys(p));
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as object)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sortKeys(x)]),
          )
        : v;
  const before = new Map(marketplace.old.plugins.map((p) => [p.name, p]));
  const withPins = marketplace.head.plugins.filter(
    (p) => before.has(p.name) && full(before.get(p.name)) !== full(p),
  );
  const withoutPins = marketplace.head.plugins.filter(
    (p) =>
      before.has(p.name) &&
      pluginDigest(before.get(p.name)) !== pluginDigest(p),
  );
  expect(withPins).toHaveLength(6);
  expect(withoutPins.map((p) => p.name).sort()).toEqual(
    [...CHANGED_PLUGINS].sort(),
  );
});

test('pluginLocation: ruta dentro del marketplace, url, git-subdir y sin origen de GitHub', () => {
  const entry = (name: string) =>
    marketplace.head.plugins.find((p) => p.name === name) as never;
  expect(pluginLocation(entry('math-proof'))).toEqual({
    url: `https://github.com/${MARKETPLACE_REPO}/tree/HEAD/plugins/math-proof`,
    githubRepo: null,
  });
  expect(pluginLocation(entry('govtribe'))).toEqual({
    url: 'https://github.com/GovTribe/claude-plugin',
    githubRepo: 'govtribe/claude-plugin',
  });
  expect(pluginLocation(entry('linq-alpha'))).toEqual({
    url: 'https://github.com/linq-lab/linq-alpha-plugin',
    githubRepo: 'linq-lab/linq-alpha-plugin',
  });
  // los de external_plugins/ también viven dentro del repo
  const external = marketplace.head.plugins.find(
    (p) =>
      typeof p.source === 'string' &&
      p.source.startsWith('./external_plugins/'),
  ) as never;
  expect(pluginLocation(external).githubRepo).toBeNull();
  expect(pluginLocation(external).url).toContain(
    '/tree/HEAD/external_plugins/',
  );
  expect(
    pluginLocation({
      name: 'x',
      source: { source: 'url', url: 'https://gitlab.com/a/b.git' },
    }),
  ).toEqual({
    url: `https://github.com/${MARKETPLACE_REPO}`,
    githubRepo: null,
  });
});

test('skillDescription lee el frontmatter real, también cuando la descripción viene plegada con ">"', () => {
  const text = skillDescription(readText('skills.SKILL.academy-guide.md'));
  expect(
    text?.startsWith(
      'Stop and check this skill before finishing any reply to a question about how to use Claude',
    ),
  ).toBe(true);
  expect(text).not.toContain('\n');
  expect(text).toContain('Claude Academy (academy.claude.com)');
  expect(
    skillDescription(readText('skills.SKILL.discernment-nudge.md')),
  ).toBeTruthy();
  expect(skillDescription('sin frontmatter')).toBeUndefined();
  expect(skillDescription('---\nname: [roto\n---')).toBeUndefined();
});

test('primera pasada: se anota el estado de las dos fuentes y no hay changelog ni candidatos', async () => {
  const result = await pass();

  expect(result.sources).toEqual([
    {
      repo: SKILLS_REPO,
      estado: 'primera-pasada',
      items: 19,
      nuevos: 0,
      actualizados: 0,
      eliminados: 0,
      resueltos: 0,
      desaparecidos: 0,
      pendientes: 0,
    },
    {
      repo: MARKETPLACE_REPO,
      estado: 'primera-pasada',
      items: 315,
      nuevos: 0,
      actualizados: 0,
      eliminados: 0,
      resueltos: 0,
      desaparecidos: 0,
      pendientes: 0,
    },
  ]);
  expect(result.repos).toEqual([]);
  expect(result.oficiales).toEqual([]);
  // 4 peticiones: commits y estado de cada repo; sin /repos de candidatos
  expect(result.stats).toMatchObject({
    requests: 4,
    notModified: 0,
    cambios: 0,
  });
  expect(gets(/\/repos\/[^/]+\/[^/]+$/)).toEqual([]);
  expect(gets(/\/commits\?per_page=20$/)).toHaveLength(1); // skills: 20 commits
  expect(gets(/\/commits\?per_page=1$/)).toHaveLength(1); // marketplace: solo HEAD
  const snapshot = readSnapshot(SKILLS_REPO);
  expect(snapshot).toMatchObject({
    head: versions.skills.head,
    etag: versions.skills.headCommitsEtag,
    fetchedAt: '2026-10-01T12:00:00.000Z',
  });
  expect(Object.keys(snapshot.items)).toHaveLength(19);
  expect(Object.keys(readSnapshot(MARKETPLACE_REPO).items)).toHaveLength(315);
});

test('anthropics/skills: el diff real del 2026-08-17 a hoy (altas, un renombrado, dos skills actualizadas y los commits en medio)', async () => {
  put(skillsBefore());
  put(pluginsBefore());

  const result = await collect();

  const entry = result.oficiales.find((o) => o.fuente === SKILLS_REPO);
  expect(entry?.desde).toBe(versions.skills.oldHead.slice(0, 7));
  expect(entry?.hasta).toBe(versions.skills.head.slice(0, 7));
  const byChange = (c: string) =>
    entry?.cambios.filter((x) => x.cambio === c).map((x) => x.nombre);
  expect(byChange('nuevo')).toEqual(['academy-guide', 'discernment-nudge']);
  // claude-academy-guide pasó a llamarse academy-guide: GitHub lo ve como baja + alta
  expect(byChange('eliminado')).toEqual(['claude-academy-guide']);
  expect(byChange('actualizado')).toEqual(['claude-api', 'frontend-design']);
  expect(entry?.cambios.every((c) => c.tipo === 'skill')).toBe(true);
  expect(entry?.cambios[0]).toMatchObject({
    cambio: 'nuevo',
    nombre: 'academy-guide',
    url: 'https://github.com/anthropics/skills/tree/HEAD/skills/academy-guide',
  });
  // la descripción de las nuevas sale de su SKILL.md; las demás no se piden
  expect(entry?.cambios[0].descripcion).toContain('Claude Academy');
  expect(
    gets(/SKILL\.md/)
      .map((r) =>
        decodeURIComponent(r.url.split('/contents/')[1].split('?')[0]),
      )
      .sort(),
  ).toEqual([
    'skills/academy-guide/SKILL.md',
    'skills/discernment-nudge/SKILL.md',
  ]);

  // los commits desde la última vez: los 8 que hay por encima del anterior en el listado real
  const position = skillsCommits.body.findIndex(
    (c) => c.sha === versions.skills.oldHead,
  );
  expect(position).toBe(8);
  expect(entry?.commits).toHaveLength(8);
  expect(entry?.commits[0]).toMatchObject({
    sha: versions.skills.head.slice(0, 7),
    fecha: '2026-09-29',
    mensaje: skillsCommits.body[0].commit.message.split('\n')[0].trim(),
  });
  expect(entry?.commits[0].mensaje).toContain('Update claude-api skill');
  expect(entry?.masCommits).toBe(false);
  expect(source(result, SKILLS_REPO)).toMatchObject({
    estado: 'con-cambios',
    items: 19,
    nuevos: 2,
    actualizados: 2,
    eliminados: 1,
  });
});

test('el marketplace real: 4 plugins nuevos, 3 cambiados y los candidatos solo de los que viven en su repo', async () => {
  put(skillsBefore());
  put(pluginsBefore());

  const result = await collect();

  const entry = result.oficiales.find((o) => o.fuente === MARKETPLACE_REPO);
  const byChange = (c: string) =>
    entry?.cambios.filter((x) => x.cambio === c).map((x) => x.nombre);
  expect(byChange('nuevo')).toEqual(NEW_PLUGINS);
  expect(byChange('actualizado')).toEqual(CHANGED_PLUGINS);
  expect(byChange('eliminado')).toEqual([]);
  expect(entry?.cambios.every((c) => c.tipo === 'plugin')).toBe(true);
  expect(entry?.commits).toEqual([]); // los commits de un marketplace son ruido de PRs
  // la URL: el repo del plugin si vive en el suyo, el árbol del marketplace si no
  const url = (name: string) =>
    entry?.cambios.find((c) => c.nombre === name)?.url;
  expect(url('govtribe')).toBe('https://github.com/GovTribe/claude-plugin');
  expect(url('math-proof')).toBe(
    `https://github.com/${MARKETPLACE_REPO}/tree/HEAD/plugins/math-proof`,
  );
  expect(
    entry?.cambios.find((c) => c.nombre === 'math-proof')?.descripcion,
  ).toBeTruthy();

  // candidatos: los tres plugins con repo propio; math-proof vive dentro del marketplace
  expect(
    gets(/\/repos\/[^/]+\/[^/]+$/)
      .map((r) => r.url.split('/repos/')[1])
      .sort(),
  ).toEqual([
    'govtribe/claude-plugin',
    'linq-lab/linq-alpha-plugin',
    'vanguard-oss/vanguard-advisor-tools',
  ]);
  expect(result.repos.map((r) => r.repo.full_name).sort()).toEqual([
    'GovTribe/claude-plugin',
    'Vanguard-oss/vanguard-advisor-tools',
    'linq-lab/linq-alpha-plugin',
  ]);
  for (const { repo, origins } of result.repos) {
    const plugin = {
      'GovTribe/claude-plugin': 'govtribe',
      'linq-lab/linq-alpha-plugin': 'linq-alpha',
      'Vanguard-oss/vanguard-advisor-tools': 'vanguard-advisor-tools',
    }[repo.full_name];
    expect(origins).toEqual([
      {
        categoria: 'claude-skills',
        tipo: 'anthropic',
        query: `${MARKETPLACE_REPO}:${plugin}`,
      },
    ]);
  }
  expect(source(result, MARKETPLACE_REPO)).toMatchObject({
    estado: 'con-cambios',
    items: 315,
    nuevos: 4,
    actualizados: 3,
    eliminados: 0,
    resueltos: 3,
    pendientes: 0,
  });
  expect(result.stats).toMatchObject({
    cambios: 5 + 7,
    resueltos: 3,
    pendientes: 0,
  });
});

test('sin categoría el colector solo lleva el changelog: no resuelve ni propone nada', async () => {
  put(skillsBefore());
  put(pluginsBefore());

  const result = await collect({ categoria: undefined });

  expect(result.repos).toEqual([]);
  expect(gets(/\/repos\/[^/]+\/[^/]+$/)).toEqual([]);
  const entry = result.oficiales.find((o) => o.fuente === MARKETPLACE_REPO);
  expect(entry?.cambios.filter((c) => c.cambio === 'nuevo')).toHaveLength(4);
});

test('un 304 en el listado de commits con la ETag guardada no pide nada más', async () => {
  put({ ...skillsBefore(), etag: versions.skills.headCommitsEtag });
  put({ ...pluginsBefore(), etag: versions.plugins.headCommitsEtag });

  const result = await collect();

  expect(state.requests.map((r) => r.ifNoneMatch)).toEqual([
    versions.skills.headCommitsEtag,
    versions.plugins.headCommitsEtag,
  ]);
  expect(result.sources.map((s) => s.estado)).toEqual([
    'sin-cambios',
    'sin-cambios',
  ]);
  expect(result.stats).toMatchObject({
    requests: 2,
    notModified: 2,
    cambios: 0,
  });
  expect(state.requests).toHaveLength(2); // ni listado de skills, ni marketplace.json, ni /repos
  expect(result.drafts).toEqual([]);
  expect(result.oficiales).toEqual([]);
});

test('si el commit anterior ya no está en la página, se dice que hay más commits', async () => {
  put({ ...skillsBefore(), head: 'a'.repeat(40) });
  put(pluginsBefore());

  const result = await collect();

  const entry = result.oficiales.find((o) => o.fuente === SKILLS_REPO);
  expect(entry?.commits).toHaveLength(20);
  expect(entry?.masCommits).toBe(true);
});

test('el tope de plugins nuevos por recogida deja el resto pendiente y vuelve la semana siguiente', async () => {
  put(skillsBefore());
  put(pluginsBefore());

  const first = await pass({ maxNewPluginRepos: 1 });

  expect(source(first, MARKETPLACE_REPO)).toMatchObject({
    resueltos: 1,
    pendientes: 2,
  });
  expect(first.repos.map((r) => r.repo.full_name)).toEqual([
    'GovTribe/claude-plugin',
  ]);
  const snapshot = readSnapshot(MARKETPLACE_REPO);
  expect(snapshot.etag).toBeNull();
  expect(snapshot.items).toHaveProperty('govtribe');
  expect(snapshot.items).toHaveProperty('math-proof'); // vive dentro: no es candidato, no queda pendiente
  expect(snapshot.items).not.toHaveProperty('linq-alpha');
  expect(snapshot.items).not.toHaveProperty('vanguard-advisor-tools');

  state.requests = [];
  const second = await pass();
  // sin ETag no hay If-None-Match: el listado se pide y se ven los dos que faltan
  expect(gets(/\/commits\?per_page=1$/)[0].ifNoneMatch).toBeNull();
  expect(gets(/\/commits\?per_page=20$/)[0].ifNoneMatch).toBe(
    versions.skills.headCommitsEtag,
  );
  const entry = second.oficiales.find((o) => o.fuente === MARKETPLACE_REPO);
  expect(entry?.cambios.map((c) => c.nombre)).toEqual([
    'linq-alpha',
    'vanguard-advisor-tools',
  ]);
  expect(second.repos.map((r) => r.repo.full_name).sort()).toEqual([
    'Vanguard-oss/vanguard-advisor-tools',
    'linq-lab/linq-alpha-plugin',
  ]);
  expect(readSnapshot(MARKETPLACE_REPO).etag).toBe(
    versions.plugins.headCommitsEtag,
  );
  expect(Object.keys(readSnapshot(MARKETPLACE_REPO).items)).toHaveLength(315);
});

test('los plugins que el tope enrich_max difirió siguen siendo nuevos la semana siguiente', async () => {
  put(skillsBefore());
  put(pluginsBefore());
  const result = await collect();

  const writes = finalizeAnthropicSnapshots(result, [
    'linq-lab/linq-alpha-plugin',
  ]);

  const plugins = writes.find(
    (w) => w.snapshot.repo === MARKETPLACE_REPO,
  )?.snapshot;
  expect(plugins?.etag).toBeNull();
  expect(plugins?.items).not.toHaveProperty('linq-alpha');
  expect(plugins?.items).toHaveProperty('govtribe');
  expect(Object.keys(plugins?.items ?? {})).toHaveLength(314);
  // skills no tiene candidatos: su instantánea queda completa y con ETag
  const skills = writes.find((w) => w.snapshot.repo === SKILLS_REPO)?.snapshot;
  expect(skills?.etag).toBe(versions.skills.headCommitsEtag);
});

test('un repo de plugin que ya no existe (404) se da por visto; uno con error transitorio (500) vuelve', async () => {
  put(skillsBefore());
  put(pluginsBefore());
  state.repoStatus.set('govtribe/claude-plugin', 404);
  state.repoStatus.set('linq-lab/linq-alpha-plugin', 500);

  const result = await pass();

  expect(source(result, MARKETPLACE_REPO)).toMatchObject({
    resueltos: 1,
    desaparecidos: 1,
    pendientes: 1,
  });
  expect(result.errors).toEqual([
    {
      source: 'anthropic-skills',
      query: MARKETPLACE_REPO,
      message: expect.stringContaining('1 plugins sin resolver'),
    },
  ]);
  expect(result.errors[0].message).toContain('linq-alpha');
  const items = readSnapshot(MARKETPLACE_REPO).items;
  expect(items).toHaveProperty('govtribe'); // desaparecido: no se reintenta
  expect(items).not.toHaveProperty('linq-alpha'); // transitorio: vuelve
});

test('si un repo falla el otro sigue; una instantánea corrupta no se sobrescribe', async () => {
  put(skillsBefore());
  fs.writeFileSync(
    anthropicSnapshotPath(snapshotDir, MARKETPLACE_REPO),
    '{ no es json',
  );
  const result = await collect();

  expect(result.sources.map((s) => s.estado)).toEqual(['con-cambios', 'error']);
  expect(result.errors).toEqual([
    {
      source: 'anthropic-skills',
      query: MARKETPLACE_REPO,
      message: expect.stringContaining('no es JSON válido; no se sobrescribe'),
    },
  ]);
  expect(
    fs.readFileSync(
      anthropicSnapshotPath(snapshotDir, MARKETPLACE_REPO),
      'utf8',
    ),
  ).toBe('{ no es json');

  // y un marketplace.json que no es JSON es un error de ese repo, no de la recogida
  state.marketplaceMode = 'invalid';
  fs.rmSync(anthropicSnapshotPath(snapshotDir, MARKETPLACE_REPO));
  put(pluginsBefore());
  const broken = await collect();
  expect(broken.sources.find((s) => s.repo === MARKETPLACE_REPO)?.estado).toBe(
    'error',
  );
  expect(broken.oficiales.some((o) => o.fuente === SKILLS_REPO)).toBe(true);
});

test('writeAnthropicSnapshots con onlyMissing crea las que faltan y no toca las que existen', async () => {
  put(skillsBefore());
  const before = fs.readFileSync(
    anthropicSnapshotPath(snapshotDir, SKILLS_REPO),
    'utf8',
  );
  const result = await collect();

  const written = await writeAnthropicSnapshots(
    finalizeAnthropicSnapshots(result, []),
    { onlyMissing: true },
  );

  expect(written).toEqual([
    anthropicSnapshotPath(snapshotDir, MARKETPLACE_REPO),
  ]); // la de skills ya estaba
  expect(
    fs.readFileSync(anthropicSnapshotPath(snapshotDir, SKILLS_REPO), 'utf8'),
  ).toBe(before);
});

test('sin token aborta antes de la primera petición; un 401 aborta la recogida', async () => {
  await expect(collect({ token: undefined })).rejects.toThrow(
    MissingTokenError,
  );
  expect(state.requests).toEqual([]);

  server.use(
    http.get('https://api.github.com/repos/:owner/:repo/commits', () =>
      HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
    ),
  );
  await expect(collect()).rejects.toThrow('GITHUB_TOKEN rechazado');
});
