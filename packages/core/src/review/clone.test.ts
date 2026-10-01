import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { gitRepoFrom, reviewFixtures, tmpDir } from '../testing/git-repo.js';
import {
  cloneConfig,
  cloneRepo,
  cloneUrl,
  headCommit,
  removeDir,
} from './clone.js';

const playwright = path.join(
  reviewFixtures,
  'repos',
  'AndyShiu__claude-skill-playwright-browser',
);

let tmp: string;
beforeEach(() => {
  tmp = tmpDir('spf-clone-');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cloneUrl solo construye URLs de GitHub desde owner/repo', () => {
  expect(cloneUrl('AndyShiu/claude-skill-playwright-browser')).toBe(
    'https://github.com/AndyShiu/claude-skill-playwright-browser.git',
  );
  for (const bad of [
    'a',
    'a/b/c',
    '../x',
    './x',
    'a/..',
    'a b/c',
    'a/b;rm',
    'https://evil.dev/x/y',
    '',
  ]) {
    expect(() => cloneUrl(bad), bad).toThrow(/Repositorio no válido/);
  }
});

test('la configuración del clon anula hooks, symlinks, LFS y todo protocolo salvo https', () => {
  const config = cloneConfig().join(' ');

  expect(config).toContain('core.hooksPath=');
  expect(config).toContain('core.fsmonitor=false');
  expect(config).toContain('core.symlinks=false');
  expect(config).toContain('protocol.allow=never');
  expect(config).toContain('protocol.https.allow=always');
  expect(config).toContain('filter.lfs.smudge=');
  expect(config).not.toContain('protocol.file.allow');
  expect(cloneConfig(true).join(' ')).toContain('protocol.file.allow=always');
});

test('clona superficialmente un repo real y deja un árbol de trabajo legible', async () => {
  const url = gitRepoFrom(playwright, path.join(tmp, 'origin'));
  const dest = path.join(tmp, 'clone');

  await cloneRepo('andyshiu/claude-skill-playwright-browser', dest, {
    url,
    allowFile: true,
  });

  expect(fs.existsSync(path.join(dest, 'scripts', 'setup.mjs'))).toBe(true);
  expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
  const shallow = execFileSync(
    'git',
    ['-C', dest, 'rev-parse', '--is-shallow-repository'],
    { encoding: 'utf8' },
  );
  expect(shallow.trim()).toBe('true');
  const head = await headCommit(dest);
  expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(Date.parse(head.date)).not.toBeNaN();
});

test('sin allowFile el protocolo file se rechaza y no queda nada en el destino', async () => {
  const url = gitRepoFrom(playwright, path.join(tmp, 'origin'));
  const dest = path.join(tmp, 'clone');

  await expect(
    cloneRepo('andyshiu/claude-skill-playwright-browser', dest, { url }),
  ).rejects.toThrow(/No se pudo clonar/);

  expect(fs.existsSync(dest)).toBe(false);
});

test('un repo que pasa del tope de tamaño se borra y se avisa', async () => {
  const url = gitRepoFrom(playwright, path.join(tmp, 'origin'));
  const dest = path.join(tmp, 'clone');

  await expect(
    cloneRepo('andyshiu/claude-skill-playwright-browser', dest, {
      url,
      allowFile: true,
      maxBytes: 1024,
    }),
  ).rejects.toThrow(/el clon pesa .* y el tope es/);

  expect(fs.existsSync(dest)).toBe(false);
});

test('un repo inexistente falla con un mensaje claro y no deja directorios', async () => {
  const dest = path.join(tmp, 'clone');

  await expect(
    cloneRepo('nadie/nada', dest, {
      url: `file:///${path.join(tmp, 'no-existe').replaceAll('\\', '/')}`,
      allowFile: true,
    }),
  ).rejects.toThrow(/No se pudo clonar nadie\/nada/);

  expect(fs.existsSync(dest)).toBe(false);
});

test.skipIf(process.platform !== 'win32')(
  'en Windows una ruta demasiado larga se rechaza antes de llamar a git',
  async () => {
    const dest = path.join(tmp, 'x'.repeat(200), 'repo');

    await expect(cloneRepo('a/b', dest)).rejects.toThrow(
      /Windows limita las rutas de git/,
    );
  },
);

test('removeDir borra un clon entero, con los ficheros de solo lectura de .git', async () => {
  const url = gitRepoFrom(playwright, path.join(tmp, 'origin'));
  const dest = path.join(tmp, 'clone');
  await cloneRepo('andyshiu/claude-skill-playwright-browser', dest, {
    url,
    allowFile: true,
  });
  expect(fs.existsSync(path.join(dest, '.git'))).toBe(true);

  await removeDir(dest);

  expect(fs.existsSync(dest)).toBe(false);
});
