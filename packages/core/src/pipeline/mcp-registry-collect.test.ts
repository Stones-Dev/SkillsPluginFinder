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
import { toGithubRepo } from '../collectors/github-graphql.js';
import {
  type McpRegistryState,
  REGISTRY_ID,
  mcpRegistryStatePath,
} from '../collectors/mcp-registry.js';
import { closeDatabases, getDb } from '../db/index.js';
import { runs, seen } from '../db/schema.js';
import {
  mcpFixtures,
  mcpHandlers,
  newMcpState,
} from '../testing/mcp-registry.js';
import { treeSnapshot } from '../testing/tree.js';
import { parseCatalog } from '../vault/catalogo.js';
import { readCandidatesFile } from './candidates-file.js';
import { collectWeek, formatDryRun } from './collect.js';

// Respuestas reales grabadas el 2026-10-02 (ver `testing/mcp-registry.ts`). Lo que sigue se ha
// derivado a mano de ellas con las reglas de abajo: de los 164 repos de GitHub del registro, 24
// llegan a 30★; 3 se descartan por licencia (sin licencia o GPL) y 1 por tener más de 20.000★ y
// quedan 20, ordenados por push más reciente (ninguno se creó en los últimos 14 días).
const { versions, graphqlObjects } = mcpFixtures;
const NOW = new Date(versions.recordedAt);
const DISCARDED = [
  ['HelpCode-ai/anythingmcp', 'licencia'],
  ['MikeyPetrillo/Agent402', 'licencia'],
  ['feder-cr/invisible_playwright_mcp', 'estrellas'],
  ['linxule/mcp-music-studio', 'licencia'],
];
const BY_PUSH = [
  'hashgraph-online/hol-guard',
  'PhilflowIO/dav-mcp',
  'yonatangross/orchestkit',
  'anypost/emailmd',
  'Fanch-hui/codex-bridge',
  'Ataraxy-Labs/sem',
  'jgravelle/jcodemunch-mcp',
  'xorrkaz/cml-mcp',
  'ChiR24/Unreal_mcp',
  'ggozad/haiku.rag',
  'keboola/mcp-server',
  'StuMason/coolify-mcp',
  'jpicklyk/task-orchestrator',
  'shinpr/mcp-local-rag',
  'BlockRunAI/blockrun-mcp',
  'activeing123/mcptoon',
  'mihai-dinculescu/tapo',
  'paiml/rust-mcp-sdk',
  'mobile-next/mobile-mcp',
  'imgly/codesign',
];

const interestsYaml = (enrichMax: number, extra = '') => `version: 1
umbral_score: 7
enrich_max: ${enrichMax}
ventana_dias: 14
idioma_informe: es
reglas_globales:
  estrellas_min: 50
  estrellas_max: 20000
  ultimo_commit_max_dias: 90
  licencias_ok: [MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense]
  licencia_no_reconocida: riesgo
  excluir_forks_sin_cambios: true
  excluir_archivados: true
categorias:
  mcp-servers:
    nombre: Servidores MCP
    peso: 1
    estrellas_min: 30
${extra}mcp_registry_categoria: mcp-servers
proyectos:
  - CRMDecoversia — CRM comercial, Laravel 11 backend + Node/Next.js frontend
`;

const state = newMcpState();
let searchItems: object[] = [];
const server = setupServer(
  ...mcpHandlers(state),
  http.get('https://api.github.com/search/repositories', () =>
    HttpResponse.json({
      total_count: searchItems.length,
      incomplete_results: false,
      items: searchItems,
    }),
  ),
  // el enrich de los candidatos: ninguno tiene README, contribuidores ni package.json en estos tests
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
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-mcp-pipeline-'));
  writeInterests(4);
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
  state.registryRequests = [];
  state.graphqlRequests = [];
  state.registryMode = 'ok';
  state.graphqlFailFor.clear();
  state.graphqlUnauthorized = false;
  state.flakyServed = 0;
  searchItems = [];
});
afterEach(() => {
  closeDatabases();
  server.resetHandlers();
  fs.rmSync(repoDir, { recursive: true, force: true });
});
afterAll(() => server.close());

const writeInterests = (enrichMax: number, extra = '') =>
  fs.writeFileSync(
    path.join(repoDir, 'interests.yaml'),
    interestsYaml(enrichMax, extra),
  );
const stateDir = () => path.join(repoDir, 'data', 'mcp-registry');
const base = (now = NOW) => ({
  repoDir,
  token: 'test-token',
  now,
  sources: ['mcp-registry'],
  throttle: false,
  retryBaseMs: 1,
});
/** El estado de hace cuatro horas, como lo dejó la recogida anterior. */
const seedState = (over: Partial<McpRegistryState> = {}) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(
    mcpRegistryStatePath(stateDir()),
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
  JSON.parse(fs.readFileSync(mcpRegistryStatePath(stateDir()), 'utf8'));
// 2026-10-02 es viernes: semana ISO 40
const week = () => '2026-W40';

test('ciclo completo: primera pasada, el diff real de 4 horas, el tope enrich_max que difiere y vuelve, y todo al día', async () => {
  // — Primera pasada: solo se anota la hora —
  const first = await collectWeek(base());
  expect(first.totalCandidates).toBe(0);
  expect(first.run.stats).toMatchObject({
    mcpPaginas: 0,
    mcpLotes: 0,
    mcpDetallados: 0,
  });
  expect(readState()).toMatchObject({
    syncedAt: NOW.toISOString(),
    pending: [],
  });
  expect(state.graphqlRequests).toEqual([]);

  // — El diff real: 24 repos con ≥30★ → 20 pasan las reglas → enrich_max=4 elige 4 —
  seedState();
  state.registryRequests = [];
  const second = await collectWeek(base());
  expect(second.run.stats).toMatchObject({
    queries: 0,
    uniqueRepos: 24,
    afterDedupe: 24,
    afterRules: 20,
    selected: 4,
    deferred: 16,
    enriched: 4,
    mcpPaginas: 3,
    mcpFilas: 246,
    mcpRepos: 164,
    mcpConsultados: 164,
    mcpDetallados: 24,
    mcpLotes: 8,
    mcpPendientes: 0,
  });
  const file = await readCandidatesFile(repoDir, week());
  expect(file?.candidates.map((c) => c.name)).toEqual(BY_PUSH.slice(0, 4));
  expect(file?.descartados.map((d) => [d.name, d.regla]).sort()).toEqual(
    [...DISCARDED].sort(),
  );
  expect(file?.diferidos).toHaveLength(16);
  const candidate = file?.candidates[0];
  expect(candidate?.source).toBe('mcp-registry');
  expect(candidate?.categoriaSugerida).toBe('mcp-servers');
  expect(candidate?.origins[0]).toMatchObject({
    categoria: 'mcp-servers',
    tipo: 'registry',
  });
  expect(candidate?.risk.notes[0]).toMatch(/^Registro MCP: .+/);
  expect(candidate?.stars).toBe(
    graphqlObjects['hashgraph-online/hol-guard'].stargazerCount,
  );

  // los 16 diferidos no se dan por vistos: quedan como pendientes, con su nota
  const pending = readState();
  expect(pending.syncedAt).toBe(NOW.toISOString());
  expect(pending.pending.map((p) => p.repo).sort()).toEqual(
    BY_PUSH.slice(4).sort(),
  );
  expect(
    pending.pending.every((p) => p.nota.startsWith('Registro MCP: ')),
  ).toBe(true);

  // — Otra ejecución: el registro no trae nada nuevo, pero los pendientes vuelven y compiten —
  state.registryMode = 'empty';
  state.graphqlRequests = [];
  const third = await collectWeek(base(new Date(NOW.getTime() + 3600e3)));
  expect(third.run.stats).toMatchObject({
    mcpFilas: 0,
    mcpConsultados: 16,
    mcpDetallados: 16,
    afterRules: 16,
    selected: 4,
    deferred: 12,
    mcpPendientes: 0,
  });
  expect(
    (await readCandidatesFile(repoDir, week()))?.candidates.map((c) => c.name),
  ).toEqual(BY_PUSH.slice(0, 8));
  expect(readState().pending).toHaveLength(12);
  // y con plazas de sobra, salen todos los que faltaban
  writeInterests(20);
  const fourth = await collectWeek(base(new Date(NOW.getTime() + 2 * 3600e3)));
  expect(fourth.run.stats).toMatchObject({
    mcpDetallados: 12,
    selected: 12,
    deferred: 0,
  });
  expect(readState().pending).toEqual([]);
  expect((await readCandidatesFile(repoDir, week()))?.candidates).toHaveLength(
    20,
  );

  // lo visto y lo registrado
  const db = getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  expect(db.select().from(seen).all()).toHaveLength(20);
  expect(db.select().from(runs).all()).toHaveLength(4);
});

test('un repo que sale de la búsqueda y del registro es un solo candidato con los dos orígenes y la nota del manifiesto', async () => {
  writeInterests(20, '    topics: [mcp]\n');
  seedState();
  // Ataraxy-Labs/sem también sale de la búsqueda de GitHub (con la forma REST del repo real)
  searchItems = [toGithubRepo(graphqlObjects['ataraxy-labs/sem'])];

  const run = await collectWeek({
    ...base(),
    sources: ['github-search', 'mcp-registry'],
  });

  expect(run.run.stats).toMatchObject({
    queries: 1,
    rawItems: 1 + 24, // 1 de la búsqueda + 24 detallados del registro
    uniqueRepos: 24, // sem cuenta una vez
    afterRules: 20,
    selected: 20,
  });
  const file = await readCandidatesFile(repoDir, week());
  const sem = file?.candidates.filter((c) => c.name === 'Ataraxy-Labs/sem');
  expect(sem).toHaveLength(1);
  expect(sem?.[0].source).toBe('github-search');
  expect(sem?.[0].origins.map((o) => o.tipo)).toEqual(['topic', 'registry']);
  expect(sem?.[0].risk.notes[0]).toMatch(/^Registro MCP: /);
  // los demás solo vienen del registro
  const other = file?.candidates.find((c) => c.name === 'xorrkaz/cml-mcp');
  expect(other?.source).toBe('mcp-registry');
  expect(other?.origins.map((o) => o.tipo)).toEqual(['registry']);
});

test('--source mcp-registry sin mcp_registry_categoria es un error; con todas las fuentes y sin ella, el registro no estorba', async () => {
  fs.writeFileSync(
    path.join(repoDir, 'interests.yaml'),
    interestsYaml(4).replace('mcp_registry_categoria: mcp-servers\n', ''),
  );
  await expect(
    collectWeek({ ...base(), source: 'mcp-registry' }),
  ).rejects.toThrow('Sin categoría para el registro MCP');
  expect(state.registryRequests).toEqual([]);

  // sin categoría y con otra fuente, simplemente no se ejecuta
  const run = await collectWeek({
    ...base(),
    sources: ['github-search', 'mcp-registry'],
  });
  expect(run.run.stats.mcpLotes).toBeUndefined();
  expect(state.registryRequests).toEqual([]);

  await expect(collectWeek({ ...base(), source: 'hn' })).rejects.toThrow(
    'solo github-search, awesome-list, anthropic-skills, mcp-registry',
  );
});

test('la categoría de mcp_registry_categoria tiene que existir en Intereses', async () => {
  fs.writeFileSync(
    path.join(repoDir, 'interests.yaml'),
    interestsYaml(4).replace(
      'mcp_registry_categoria: mcp-servers',
      'mcp_registry_categoria: no-existe',
    ),
  );
  await expect(collectWeek(base())).rejects.toThrow(
    'la categoría "no-existe" no existe en categorias',
  );
});

test('si el registro cae y es la única fuente, la recogida falla sin escribir candidatos ni avanzar el estado', async () => {
  seedState();
  const before = fs.readFileSync(mcpRegistryStatePath(stateDir()), 'utf8');
  state.registryMode = 'down';

  await expect(collectWeek(base())).rejects.toThrow(
    'El registro MCP falló (HTTP 503)',
  );

  expect(fs.existsSync(path.join(repoDir, 'data', 'candidates'))).toBe(false);
  expect(fs.readFileSync(mcpRegistryStatePath(stateDir()), 'utf8')).toBe(
    before,
  );
});

test('si la recogida falla a mitad, el estado sigue siendo el anterior y no se pierde nada', async () => {
  seedState();
  const before = treeSnapshot(stateDir());
  // un directorio ocupa el nombre del temporal del fichero de la semana: la recogida revienta
  // después de leer el registro y de enriquecer, justo al dejar los candidatos
  const blocker = path.join(
    repoDir,
    'data',
    'candidates',
    `${week()}.json.${process.pid}.tmp`,
  );
  fs.mkdirSync(blocker, { recursive: true });

  await expect(collectWeek(base())).rejects.toThrow();

  expect(treeSnapshot(stateDir())).toEqual(before);
  fs.rmSync(blocker, { recursive: true });
  const retry = await collectWeek(base());
  expect(retry.run.stats).toMatchObject({ mcpDetallados: 24, selected: 4 });
});

test('dry-run sin estado: lo crea (única escritura) y no toca nada más de data/', async () => {
  const result = await collectWeek({ ...base(), dryRun: true });

  expect(result.mcpRegistry).toMatchObject({
    estadoCreado: true,
    requests: 1,
    lotes: 0,
  });
  expect(result.mcpRegistry?.report.estado).toBe('primera-pasada');
  expect(Object.keys(treeSnapshot(path.join(repoDir, 'data')))).toEqual([
    path.join('mcp-registry', 'registry.modelcontextprotocol.io.json'),
  ]);
});

test('dry-run con estado: cuenta el diff y los candidatos de verdad y no sobrescribe nada; data/ idéntico', async () => {
  seedState();
  const data = path.join(repoDir, 'data');
  const before = treeSnapshot(data);

  const result = await collectWeek({ ...base(), dryRun: true });
  closeDatabases();

  expect(treeSnapshot(data)).toEqual(before);
  expect(result.mcpRegistry).toMatchObject({
    estadoCreado: false,
    requests: 3,
    lotes: 8,
    puntos: 8,
  });
  expect(result.mcpRegistry?.report).toMatchObject({
    filas: 246,
    repos: 164,
    detallados: 24,
  });
  expect(result.stats).toMatchObject({
    uniqueRepos: 24,
    afterRules: 20,
    selected: 4,
    deferred: 16,
  });
  expect(result.fuentes).toEqual(['mcp-registry']);
  expect(result.muestra.map((m) => m.name)).toEqual(BY_PUSH.slice(0, 4));
  // un segundo ensayo ve lo mismo: el primero no se comió nada
  const again = await collectWeek({ ...base(), dryRun: true });
  expect(again.mcpRegistry?.report).toEqual(result.mcpRegistry?.report);

  const text = formatDryRun(result).join('\n');
  expect(text).toContain('DRY-RUN ·');
  expect(text).toContain(
    'salvo las instantáneas de data/mcp-registry que falten',
  );
  expect(text).toContain(
    'mcp-registry: 3 páginas del registro · 8 consultas GraphQL (8 puntos del cubo GraphQL)',
  );
  expect(text).toContain(
    'registro: 246 servidores actualizados → 238 activos → 166 con repo de GitHub → 164 repos distintos',
  );
  expect(text).toContain(
    'etapa 1 (estrellas): 164 consultados → 24 llegan al mínimo → etapa 2 (detalle): 24 candidatos · desaparecidos 7 · pendientes 0',
  );
});
