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
  type AnthropicSnapshot,
  MARKETPLACE_REPO,
  SKILLS_REPO,
  anthropicSnapshotPath,
  pluginDigest,
} from '../collectors/anthropic.js';
import { parseInterestsYaml } from '../config/interests.js';
import { closeDatabases, getDb } from '../db/index.js';
import { runs, seen } from '../db/schema.js';
import { renderReport } from '../publish/report.js';
import {
  anthropicFixtures,
  anthropicHandlers,
  newAnthropicState,
} from '../testing/anthropic.js';
import { treeSnapshot } from '../testing/tree.js';
import { parseCatalog } from '../vault/catalogo.js';
import { readCandidatesFile } from './candidates-file.js';
import { collectWeek, formatDryRun } from './collect.js';

// Respuestas reales de GitHub grabadas el 2026-10-01 (ver `testing/anthropic.ts`).
const { versions, skillsListing, marketplace } = anthropicFixtures;

const interestsYaml = (enrichMax: number) => `version: 1
umbral_score: 7
enrich_max: ${enrichMax}
ventana_dias: 14
idioma_informe: es
reglas_globales:
  estrellas_min: 50
  ultimo_commit_max_dias: 90
  licencias_ok: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense]
  licencia_no_reconocida: riesgo
  excluir_forks_sin_cambios: true
  excluir_archivados: true
categorias:
  claude-skills:
    nombre: Skills y plugins para Claude y Claude Code
    peso: 1
    estrellas_min: 0
anthropic_categoria: claude-skills
proyectos:
  - CRMDecoversia — CRM comercial, Laravel 11 backend + Node/Next.js frontend
`;

const state = newAnthropicState();
const server = setupServer(
  ...anthropicHandlers(state),
  // el enrich de los candidatos: ninguno tiene README, contribuidores ni package.json en estos tests
  http.get('https://api.github.com/repos/:owner/:repo/readme', () =>
    HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
  http.get('https://api.github.com/repos/:owner/:repo/contributors', () =>
    HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
  ),
);

let repoDir: string;
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-anthropic-pipeline-'));
  writeInterests(2);
  fs.writeFileSync(
    path.join(repoDir, 'catalog.json'),
    JSON.stringify(
      parseCatalog(
        fs
          .readFileSync(
            path.resolve(
              import.meta.dirname,
              '../../tests/fixtures/vault/Catalogo.md',
            ),
            'utf8',
          )
          .replace(/\r\n/g, '\n'),
      ),
    ),
  );
  state.requests = [];
  state.marketplaceMode = 'ok';
  state.repoStatus.clear();
});
afterEach(() => {
  closeDatabases();
  server.resetHandlers();
  fs.rmSync(repoDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const writeInterests = (enrichMax: number) =>
  fs.writeFileSync(
    path.join(repoDir, 'interests.yaml'),
    interestsYaml(enrichMax),
  );
const W40 = new Date('2026-09-30T12:00:00Z');
const W41 = new Date('2026-10-05T12:00:00Z');
const base = (now: Date) => ({
  repoDir,
  token: 'test-token',
  now,
  sources: ['anthropic-skills'],
  throttle: false,
  retryBaseMs: 1,
});
const snapshotDir = () => path.join(repoDir, 'data', 'anthropic');
const readSnapshot = (repo: string): AnthropicSnapshot =>
  JSON.parse(
    fs.readFileSync(anthropicSnapshotPath(snapshotDir(), repo), 'utf8'),
  );
/** El estado de hace unas semanas, construido con los datos reales de entonces. */
function seedOldSnapshots() {
  fs.mkdirSync(snapshotDir(), { recursive: true });
  const write = (snapshot: AnthropicSnapshot) =>
    fs.writeFileSync(
      anthropicSnapshotPath(snapshotDir(), snapshot.repo),
      JSON.stringify(snapshot),
    );
  write({
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
  write({
    version: 1,
    repo: MARKETPLACE_REPO,
    etag: 'W/"viejo"',
    head: versions.plugins.oldHead,
    fetchedAt: '2026-09-23T12:00:00.000Z',
    items: Object.fromEntries(
      marketplace.old.plugins.map((p) => [p.name, pluginDigest(p)]),
    ),
  });
}
const dbRuns = () =>
  getDb(path.join(repoDir, 'data', 'seen.sqlite'))
    .select()
    .from(runs)
    .all();

test('ciclo completo: primera pasada, las novedades reales del marketplace y de skills, el tope que difiere un plugin y el 304', async () => {
  writeInterests(1); // una sola plaza: de los dos candidatos que pasan las reglas, uno se difiere

  // — Primera pasada: solo las instantáneas —
  const first = await collectWeek(base(W40));
  expect(first.totalCandidates).toBe(0);
  expect(first.run.stats).toMatchObject({
    queries: 0,
    anthropicRequests: 4,
    anthropicNotModified: 0,
    anthropicCambios: 0,
    anthropicResueltos: 0,
  });
  expect(
    (await readCandidatesFile(repoDir, '2026-W40'))?.oficiales,
  ).toBeUndefined();
  expect(fs.readdirSync(snapshotDir()).sort()).toEqual([
    'anthropics-claude-plugins-official.json',
    'anthropics-skills.json',
  ]);

  // — Semana 41: las instantáneas de hace unas semanas contra HEAD real —
  seedOldSnapshots();
  const second = await collectWeek(base(W41));

  // Los tres plugins nuevos que viven en su repo, con lo que dicen sus datos reales: GovTribe y
  // linq-alpha (Apache-2.0, 0★) pasan con estrellas_min 0; vanguard-advisor-tools no tiene licencia.
  expect(second.run.stats).toMatchObject({
    uniqueRepos: 3,
    afterDedupe: 3,
    afterRules: 2,
    selected: 1,
    deferred: 1,
    enriched: 1,
    anthropicCambios: 12, // skills: 2 nuevas + 1 baja + 2 actualizadas · marketplace: 4 nuevos + 3 cambiados
    anthropicResueltos: 3,
    anthropicPendientes: 0,
  });
  const afterSecond = await readCandidatesFile(repoDir, '2026-W41');
  // sin ninguno creado en la ventana, manda el push más reciente: linq-alpha (2026-09-29)
  expect(afterSecond?.candidates.map((c) => c.name)).toEqual([
    'linq-lab/linq-alpha-plugin',
  ]);
  const candidate = afterSecond?.candidates[0];
  expect(candidate?.source).toBe('anthropic-skills');
  expect(candidate?.categoriaSugerida).toBe('claude-skills');
  expect(candidate?.origins).toEqual([
    {
      categoria: 'claude-skills',
      tipo: 'anthropic',
      query: `${MARKETPLACE_REPO}:linq-alpha`,
    },
  ]);
  expect(afterSecond?.descartados.map((d) => [d.name, d.regla])).toEqual([
    ['Vanguard-oss/vanguard-advisor-tools', 'licencia'],
  ]);
  expect(afterSecond?.diferidos.map((d) => d.name)).toEqual([
    'GovTribe/claude-plugin',
  ]);

  // el changelog oficial queda en el fichero de la semana
  expect(afterSecond?.oficiales?.map((o) => o.fuente)).toEqual([
    SKILLS_REPO,
    MARKETPLACE_REPO,
  ]);
  expect(afterSecond?.oficiales?.[0].commits).toHaveLength(8);

  // y se ve en el informe, sin tocar nada de lo demás
  const report = renderReport({
    week: '2026-W41',
    now: W41,
    interests: parseInterestsYaml(interestsYaml(1)),
    file: afterSecond as NonNullable<typeof afterSecond>,
    scorings: [],
  });
  expect(report).toContain('## Novedades oficiales de Anthropic');
  expect(report).toContain(
    '- **nuevo** skill [academy-guide](https://github.com/anthropics/skills/tree/HEAD/skills/academy-guide) — Stop and check this skill',
  );
  expect(report).toContain('- **eliminado** skill [claude-academy-guide]');
  expect(report).toContain(
    '- **nuevo** plugin [govtribe](https://github.com/GovTribe/claude-plugin)',
  );
  expect(report).toContain('- **actualizado** plugin [postman]');
  expect(report).toContain('Update claude-api skill: Claude Opus 5.5 default');
  expect(report.indexOf('## Novedades oficiales')).toBeLessThan(
    report.indexOf('## Errores por fuente'),
  );

  // el plugin diferido por el tope no se da por visto: fuera de la instantánea y sin ETag
  expect(readSnapshot(MARKETPLACE_REPO).etag).toBeNull();
  expect(readSnapshot(MARKETPLACE_REPO).items).not.toHaveProperty('govtribe');
  expect(readSnapshot(MARKETPLACE_REPO).items).toHaveProperty('linq-alpha');
  // skills no tiene candidatos: su instantánea queda al día
  expect(readSnapshot(SKILLS_REPO)).toMatchObject({
    head: versions.skills.head,
    etag: versions.skills.headCommitsEtag,
  });

  // — Segunda ejecución de la semana: solo vuelve el diferido, y ahora no hay otro con quien competir —
  const third = await collectWeek(base(new Date('2026-10-06T12:00:00Z')));
  expect(third.run.stats).toMatchObject({
    anthropicCambios: 1,
    anthropicResueltos: 1,
    afterRules: 1,
    selected: 1,
    deferred: 0,
  });
  const afterThird = await readCandidatesFile(repoDir, '2026-W41');
  expect(afterThird?.candidates.map((c) => c.name)).toEqual([
    'linq-lab/linq-alpha-plugin',
    'GovTribe/claude-plugin',
  ]);
  expect(afterThird?.diferidos).toEqual([]);
  // el changelog de las dos ejecuciones de la semana se acumula: el de la segunda es solo el plugin que volvió
  expect(afterThird?.oficiales).toHaveLength(3);
  expect(afterThird?.oficiales?.[2]).toMatchObject({
    fuente: MARKETPLACE_REPO,
    desde: versions.plugins.head.slice(0, 7),
    hasta: versions.plugins.head.slice(0, 7),
    commits: [],
    cambios: [{ cambio: 'nuevo', nombre: 'govtribe' }],
  });
  expect(readSnapshot(MARKETPLACE_REPO).etag).toBe(
    versions.plugins.headCommitsEtag,
  );
  expect(Object.keys(readSnapshot(MARKETPLACE_REPO).items)).toHaveLength(315);

  // — Y con todo al día, los dos listados de commits contestan 304 —
  state.requests = [];
  const fourth = await collectWeek(base(new Date('2026-10-07T12:00:00Z')));
  expect(fourth.run.stats).toMatchObject({
    anthropicRequests: 2,
    anthropicNotModified: 2,
    anthropicCambios: 0,
    selected: 0,
  });
  expect(state.requests).toHaveLength(2);

  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(db.select().from(seen).all()).toHaveLength(2);
  expect(dbRuns()).toHaveLength(4);
});

test('sin anthropic_categoria el colector lleva el changelog pero no propone candidatos', async () => {
  fs.writeFileSync(
    path.join(repoDir, 'interests.yaml'),
    interestsYaml(5).replace('anthropic_categoria: claude-skills\n', ''),
  );
  seedOldSnapshots();

  const run = await collectWeek(base(W41));

  expect(run.run.stats).toMatchObject({
    uniqueRepos: 0,
    anthropicResueltos: 0,
  });
  const file = await readCandidatesFile(repoDir, '2026-W41');
  expect(file?.candidates).toEqual([]);
  expect(file?.oficiales).toHaveLength(2);
});

test('la categoría de anthropic_categoria tiene que existir en Intereses', () => {
  expect(() =>
    parseInterestsYaml(
      interestsYaml(5).replace(
        'anthropic_categoria: claude-skills',
        'anthropic_categoria: no-existe',
      ),
    ),
  ).toThrow('la categoría "no-existe" no existe en categorias');
});

test('--source anthropic-skills recoge solo eso; con todas las fuentes y sin awesome_listas, no estorba', async () => {
  seedOldSnapshots();
  const only = await collectWeek({ ...base(W41), source: 'anthropic-skills' });
  expect(only.run.stats.queries).toBe(0);
  expect(
    state.requests.some((r) => r.url.includes('/search/repositories')),
  ).toBe(false);
  await expect(collectWeek({ ...base(W41), source: 'hn' })).rejects.toThrow(
    'solo github-search, awesome-list, anthropic-skills',
  );
});

test('si los dos repos fallan y es la única fuente, la recogida falla sin escribir candidatos', async () => {
  server.use(
    http.get('https://api.github.com/repos/:owner/:repo/commits', () =>
      HttpResponse.json({ message: 'boom' }, { status: 500 }),
    ),
  );
  await expect(collectWeek(base(W40))).rejects.toThrow(
    'Todos los repos de anthropic-skills fallaron',
  );
  expect(fs.existsSync(path.join(repoDir, 'data', 'candidates'))).toBe(false);
});

test('si la recogida falla a mitad, las instantáneas siguen siendo las anteriores', async () => {
  seedOldSnapshots();
  const before = treeSnapshot(snapshotDir());
  // un directorio ocupa el nombre del temporal del fichero de la semana: la recogida revienta
  // después de ver las novedades y de enriquecerlas, justo al dejarlas en candidatos
  const blocker = path.join(
    repoDir,
    'data',
    'candidates',
    `2026-W41.json.${process.pid}.tmp`,
  );
  fs.mkdirSync(blocker, { recursive: true });

  await expect(collectWeek(base(W41))).rejects.toThrow();

  expect(treeSnapshot(snapshotDir())).toEqual(before);
  fs.rmSync(blocker, { recursive: true });
  const retry = await collectWeek(base(W41));
  expect(retry.run.stats).toMatchObject({
    anthropicCambios: 12,
    anthropicResueltos: 3,
  });
});

test('dry-run sin instantáneas: las crea (única escritura) y no toca nada más de data/', async () => {
  const result = await collectWeek({ ...base(W40), dryRun: true });

  expect(result.anthropic?.snapshotsCreadas).toBe(2);
  expect(result.anthropic?.repos.map((r) => r.estado)).toEqual([
    'primera-pasada',
    'primera-pasada',
  ]);
  expect(Object.keys(treeSnapshot(path.join(repoDir, 'data'))).sort()).toEqual([
    path.join('anthropic', 'anthropics-claude-plugins-official.json'),
    path.join('anthropic', 'anthropics-skills.json'),
  ]);
});

test('dry-run con instantáneas: cuenta el changelog y los candidatos de verdad y no sobrescribe nada; data/ idéntico', async () => {
  seedOldSnapshots();
  const data = path.join(repoDir, 'data');
  const before = treeSnapshot(data);

  const result = await collectWeek({ ...base(W41), dryRun: true });
  closeDatabases();

  expect(treeSnapshot(data)).toEqual(before);
  expect(result.anthropic).toMatchObject({ snapshotsCreadas: 0 });
  expect(result.stats).toMatchObject({
    uniqueRepos: 3,
    afterRules: 2,
    selected: 2,
  });
  expect(result.fuentes).toEqual(['anthropic-skills']);
  const marketplaceEntry = result.anthropic?.oficiales.find(
    (o) => o.fuente === MARKETPLACE_REPO,
  );
  expect(
    marketplaceEntry?.cambios
      .filter((c) => c.cambio === 'nuevo')
      .map((c) => c.nombre),
  ).toEqual(anthropicFixtures.NEW_PLUGINS);
  // un segundo ensayo ve exactamente lo mismo: el primero no se comió nada
  const again = await collectWeek({ ...base(W41), dryRun: true });
  expect(again.anthropic?.oficiales).toEqual(result.anthropic?.oficiales);

  const text = formatDryRun(result).join('\n');
  expect(text).toContain(
    'DRY-RUN · semana 2026-W41 · anthropic-skills — no se escribe nada',
  );
  expect(text).toContain('salvo las instantáneas de data/anthropic que falten');
  expect(text).toMatch(
    /anthropics\/skills\s+con cambios · 19 elementos · \+2 ~2 -1/,
  );
  expect(text).toMatch(
    /anthropics\/claude-plugins-official\s+con cambios · 315 elementos · \+4 ~3 -0 \(candidatos resueltos 3/,
  );
  expect(text).toContain(
    'changelog anthropics/skills (89dcaa3…8a1541c): 5 cambios, 8 commits',
  );
  expect(text).toContain('nuevo       plugin govtribe');
});
