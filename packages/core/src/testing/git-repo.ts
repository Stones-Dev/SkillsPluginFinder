// Ayudas de test para `spf review`: repos git temporales hechos con ficheros reales de
// las fixtures y árboles de ficheros en un directorio temporal. No forma parte de la API.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GIT_NULL } from '../review/clone.js';

export const reviewFixtures = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/review',
);

export const tmpDir = (prefix = 'spf-review-') =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Escribe `{ 'ruta/relativa': contenido }` bajo `root` y devuelve `root`. */
export function writeTree(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

/** Copia `src` a `dest`, lo convierte en un repo git con un commit y devuelve su URL `file://`. */
export function gitRepoFrom(src: string, dest: string): string {
  fs.cpSync(src, dest, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=spf-test',
        '-c',
        'user.email=spf-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        cwd: dest,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: GIT_NULL,
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: 'pipe',
      },
    );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return pathToFileURL(dest).href;
}
