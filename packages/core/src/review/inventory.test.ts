import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { reviewFixtures, tmpDir, writeTree } from '../testing/git-repo.js';
import { inspectRepo } from './inventory.js';
import type { SignalType } from './signals.js';

// Repos reales de la W40 (ficheros copiados de su rama principal): playwright-browser
// entero salvo las 7 capturas PNG; ai-kit y arc-library solo con los ficheros que usan los tests.
const repo = (name: string) => path.join(reviewFixtures, 'repos', name);
const types = (signals: { tipo: SignalType }[]) =>
  signals.map((s) => s.tipo).sort();

test('playwright-browser (real): su único aviso es el script de instalación scripts/setup.mjs', async () => {
  const inv = await inspectRepo(
    repo('AndyShiu__claude-skill-playwright-browser'),
  );

  expect(inv.signals).toEqual([
    {
      tipo: 'install-script',
      detalle: 'scripts/setup.mjs: script de instalación o preparación',
      fuente: 'inventario',
    },
  ]);
  expect(inv.tree.files).toBe(15);
  expect(inv.manifiestos).toEqual(['package.json']);
  expect(inv.notas).toContain('package.json: scripts setup');
});

test('ai-kit (real): install.sh, servidor MCP remoto y hooks que ejecutan comandos', async () => {
  const inv = await inspectRepo(repo('solanabr__ai-kit'));

  expect(types(inv.signals)).toEqual([
    'install-script',
    'mcp-remoto',
    'privilegios',
  ]);
  expect(inv.signals.find((s) => s.tipo === 'mcp-remoto')?.detalle).toContain(
    'solana-dev es remoto (https://mcp.solana.com/mcp)',
  );
  expect(inv.signals.find((s) => s.tipo === 'privilegios')?.detalle).toContain(
    'plugin/hooks/hooks.json: hooks que ejecutan comandos',
  );
  // observaciones que no bloquean
  expect(inv.notas.join('\n')).toContain('20 submódulos de terceros');
  expect(inv.notas.join('\n')).toContain('helius se lanza con npx');
});

test('arc-library (real): el repositorio es un registro shadcn propio', async () => {
  const inv = await inspectRepo(repo('kuratlielia__arc-library'));

  expect(types(inv.signals)).toEqual(['registro-propio']);
  expect(inv.signals[0].detalle).toContain('registry.json');
});

let tmp: string;
beforeEach(() => {
  tmp = tmpDir('spf-inventory-');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const real = (rel: string) =>
  fs.readFileSync(path.resolve(reviewFixtures, '..', rel), 'utf8');

test('un postinstall real (CloddsBot) en package.json es install-script', async () => {
  writeTree(tmp, {
    'package.json': real('github-enrich/alsk1992__CloddsBot.package.json'),
  });

  const inv = await inspectRepo(tmp);

  expect(types(inv.signals)).toEqual(['install-script']);
  expect(inv.signals[0].detalle).toMatch(/^package\.json: .*postinstall/);
});

test('un package.json real sin scripts de instalación (solana-web3.js) no da señales', async () => {
  writeTree(tmp, {
    'package.json': real(
      'github-enrich/solana-foundation__solana-web3.js.package.json',
    ),
  });

  expect((await inspectRepo(tmp)).signals).toEqual([]);
});

// Las pruebas siguientes usan fragmentos mínimos escritos en un directorio temporal
// (no hay un repo real a mano con cada caso).

test.each<[string, Record<string, string>, SignalType, string]>([
  [
    'package.json con dependencia desde git',
    {
      'package.json': JSON.stringify({
        dependencies: { x: 'github:someone/x#main', ok: '^1.0.0' },
      }),
    },
    'registro-propio',
    'x@github:someone/x#main',
  ],
  [
    'dependencia con la forma corta owner/repo',
    { 'package.json': JSON.stringify({ devDependencies: { y: 'a/b' } }) },
    'registro-propio',
    'y@a/b',
  ],
  [
    'publishConfig.registry propio',
    {
      'package.json': JSON.stringify({
        publishConfig: { registry: 'https://npm.example.com/' },
      }),
    },
    'registro-propio',
    'publishConfig.registry',
  ],
  [
    '.npmrc con un registro de scope propio',
    { '.npmrc': '@acme:registry=https://npm.acme.dev/\n' },
    'registro-propio',
    '.npmrc: registry = https://npm.acme.dev/',
  ],
  [
    'components.json con un registro shadcn',
    {
      'components.json': JSON.stringify({
        registries: { '@acme': 'https://acme.dev/r/{name}.json' },
      }),
    },
    'registro-propio',
    'registro shadcn @acme',
  ],
  [
    'Cargo.toml con build script',
    { 'Cargo.toml': '[package]\nname = "x"\nbuild = "build.rs"\n' },
    'install-script',
    'Cargo.toml: declara un build script',
  ],
  [
    'Cargo.toml con dependencia desde git',
    {
      'Cargo.toml':
        '[dependencies]\nfoo = { git = "https://github.com/a/foo" }\n',
    },
    'registro-propio',
    'dependencias de Rust desde git',
  ],
  [
    'build.rs',
    { 'crate/build.rs': 'fn main() {}\n' },
    'install-script',
    'crate/build.rs',
  ],
  [
    '.csproj con tarea <Exec>',
    {
      'App/App.csproj':
        '<Project><Target Name="T" BeforeTargets="Build"><Exec Command="echo hi" /></Target></Project>',
    },
    'install-script',
    '<Exec>',
  ],
  [
    'NuGet.config con una fuente propia',
    {
      'NuGet.Config':
        '<configuration><packageSources><add key="a" value="https://nuget.acme.dev/v3/index.json" /><add key="n" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>',
    },
    'registro-propio',
    'https://nuget.acme.dev/v3/index.json',
  ],
  [
    'requirements.txt con --extra-index-url',
    {
      'requirements.txt':
        '--extra-index-url https://pypi.acme.dev/simple\nrequests\n',
    },
    'registro-propio',
    'índice de paquetes de Python propio',
  ],
  [
    'setup.py',
    { 'setup.py': 'from setuptools import setup\nsetup()\n' },
    'install-script',
    'setup.py',
  ],
  [
    'servidor MCP con transporte sse',
    {
      '.mcp.json': JSON.stringify({
        mcpServers: { remoto: { type: 'sse', url: 'https://x.dev/sse' } },
      }),
    },
    'mcp-remoto',
    'remoto es remoto',
  ],
  [
    'servidor MCP vía mcp-remote',
    {
      '.mcp.json': JSON.stringify({
        mcpServers: {
          puente: {
            command: 'npx',
            args: ['-y', 'mcp-remote', 'https://x.dev'],
          },
        },
      }),
    },
    'mcp-remoto',
    'puente es remoto',
  ],
  [
    'server.json del registro MCP con remotes',
    {
      'server.json': JSON.stringify({
        remotes: [{ type: 'streamable-http', url: 'https://x.dev/mcp' }],
      }),
    },
    'mcp-remoto',
    'declara remotos',
  ],
  [
    'README que configura un MCP remoto',
    { 'README.md': 'claude mcp add --transport http demo https://x.dev/mcp\n' },
    'mcp-remoto',
    'la documentación configura',
  ],
  [
    'skill con allowed-tools: Bash',
    {
      'skills/a/SKILL.md':
        '---\nname: a\nallowed-tools: Read, Bash\n---\n# A\n',
    },
    'privilegios',
    'declara Bash sin restringir',
  ],
  [
    'comando con allowed-tools: Bash(*)',
    {
      'commands/run.md': '---\nallowed-tools:\n  - Read\n  - Bash(*)\n---\nx\n',
    },
    'privilegios',
    'declara Bash sin restringir',
  ],
  [
    'script de instalación con sudo',
    { 'scripts/install.sh': '#!/bin/sh\nsudo apt-get install -y foo\n' },
    'privilegios',
    'usa sudo',
  ],
  [
    'script que pide ejecutarse como administrador',
    { 'tools/run.ps1': 'Start-Process pwsh -Verb RunAs\n' },
    'privilegios',
    'como administrador',
  ],
  [
    'ajustes con permissions.allow sin restringir',
    {
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Read', 'Bash'] },
      }),
    },
    'privilegios',
    'permissions.allow concede herramientas sin restringir',
  ],
  [
    'ajustes con bypassPermissions',
    {
      '.claude/settings.json': JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
      }),
    },
    'privilegios',
    'bypassPermissions',
  ],
])('señal: %s', async (_name, files, tipo, detail) => {
  writeTree(tmp, files);

  const inv = await inspectRepo(tmp);

  const hit = inv.signals.find((s) => s.tipo === tipo);
  expect(hit, JSON.stringify(inv.signals)).toBeDefined();
  expect(hit?.detalle).toContain(detail);
});

test.each<[string, Record<string, string>]>([
  [
    'Bash restringido por patrón',
    {
      'commands/x.md': '---\nallowed-tools: Bash(git status:*), Read\n---\nx\n',
    },
  ],
  [
    'script de instalación dentro de tests/',
    { 'tests/install.sh': 'echo hola\n' },
  ],
  [
    'servidor MCP local sin URL',
    {
      '.mcp.json': JSON.stringify({
        mcpServers: { local: { command: 'node', args: ['server.js'] } },
      }),
    },
  ],
  [
    'dependencias del registro con rangos',
    {
      'package.json': JSON.stringify({
        dependencies: { a: '^1.2.3', b: '~2.0.0', c: 'npm:@x/y@1.0.0' },
      }),
    },
  ],
  [
    'prepare no es un script de ciclo de instalación',
    { 'package.json': JSON.stringify({ scripts: { prepare: 'husky' } }) },
  ],
])('sin señal: %s', async (_name, files) => {
  writeTree(tmp, files);

  expect((await inspectRepo(tmp)).signals).toEqual([]);
});

test('un frontmatter ---js no se ejecuta (gray-matter lo evaluaría)', async () => {
  const flag = '__spfPwned';
  (globalThis as Record<string, unknown>)[flag] = undefined;
  writeTree(tmp, {
    'skills/x/SKILL.md': `---js\nglobalThis.${flag} = true;\n({ "allowed-tools": "Read" })\n---\n# x\n`,
  });

  await inspectRepo(tmp);

  expect((globalThis as Record<string, unknown>)[flag]).toBeUndefined();
});

test('no entra en .git ni en node_modules', async () => {
  writeTree(tmp, {
    '.git/hooks/postinstall.sh': 'echo no\n',
    'node_modules/dep/install.sh': 'echo no\n',
    'README.md': 'hola\n',
  });

  const inv = await inspectRepo(tmp);

  expect(inv.tree.files).toBe(1);
  expect(inv.signals).toEqual([]);
});

test('un JSON roto se anota y no tumba el inventario', async () => {
  writeTree(tmp, { 'package.json': '{ esto no es json' });

  const inv = await inspectRepo(tmp);

  expect(inv.signals).toEqual([]);
  expect(inv.notas).toContain('package.json no se pudo leer como JSON.');
});
