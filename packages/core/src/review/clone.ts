import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { walkTree } from './tree.js';

const run = promisify(execFile);

/** Tiempo máximo del clon y tope de tamaño de lo descargado (Constitución §1, solo lectura). */
export const CLONE_TIMEOUT_MS = 120_000;
export const CLONE_MAX_BYTES = 200 * 1024 * 1024;

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** El «fichero vacío» que entiende git: `os.devNull` en Windows (`\.\nul`) no lo abre. */
export const GIT_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Margen para `.git/objects/pack/pack-<sha>.pack` (unos 70 caracteres) bajo MAX_PATH. */
export const MAX_DEST_LENGTH = 180;
const TRANSIENT = /unable to rename|permission denied|used by another process/i;

/**
 * Entorno de git sin la configuración del usuario ni del sistema: nada de
 * `insteadOf`, filtros ni helpers heredados que cambien lo que hace el clon.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL,
  };
}

/**
 * Opciones `-c` que anulan lo que un repositorio ajeno podría ejecutar o colar
 * al clonarlo: sin hooks, sin monitor de ficheros, sin symlinks, sin filtros
 * LFS y solo `https` (o `file` en los tests, con `allowFile`).
 */
export function cloneConfig(allowFile = false): string[] {
  const config = [
    `core.hooksPath=${path.join(os.tmpdir(), 'spf-sin-hooks')}`,
    'core.fsmonitor=false',
    'core.symlinks=false',
    'core.longpaths=true',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'filter.lfs.smudge=',
    'filter.lfs.process=',
    'filter.lfs.required=false',
  ];
  if (allowFile) config.push('protocol.file.allow=always');
  return config.flatMap((c) => ['-c', c]);
}

/**
 * URL del clon, construida solo desde el `owner/repo` del catálogo; nunca desde
 * un README ni una descripción, que son datos de terceros.
 */
export function cloneUrl(repo: string): string {
  if (
    !REPO_PATTERN.test(repo) ||
    repo.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`Repositorio no válido: "${repo}" (se espera owner/repo).`);
  }
  return `https://github.com/${repo}.git`;
}

export type CloneOptions = {
  /** URL a clonar; por defecto la de GitHub del `repo`. Solo para los tests. */
  url?: string;
  /** Permite el protocolo `file`. Solo para los tests. */
  allowFile?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
};

/** Borra un directorio aunque tenga ficheros de solo lectura (los `.git` de Windows). */
export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * `git clone --depth 1` sin shell, sin submódulos, sin tags y sin ejecutar nada
 * del repositorio. Si falla o pasa del tope de tamaño, no deja nada en `dest`.
 */
export async function cloneRepo(
  repo: string,
  dest: string,
  options: CloneOptions = {},
): Promise<void> {
  const url = options.url ?? cloneUrl(repo);
  const absolute = path.resolve(dest);
  if (process.platform === 'win32' && absolute.length > MAX_DEST_LENGTH) {
    // `git` renombra `.git/objects/pack/pack-<sha>.pack` y falla por encima de MAX_PATH
    // aunque `core.longpaths` esté activo.
    throw new Error(
      `No se pudo clonar ${repo}: la ruta ${absolute} tiene ${absolute.length} caracteres y Windows limita las rutas de git a unos 260 (el tope aquí es ${MAX_DEST_LENGTH}).`,
    );
  }
  await removeDir(dest);
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const args = [
    ...cloneConfig(options.allowFile),
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    '--no-recurse-submodules',
    '--template=',
    '--quiet',
    '--',
    url,
    dest,
  ];
  const attempt = () =>
    run('git', args, {
      env: gitEnv(),
      timeout: options.timeoutMs ?? CLONE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  try {
    try {
      await attempt();
    } catch (err) {
      // Un antivirus o el indexador de Windows pueden bloquear un instante el `.pack`.
      if (!TRANSIENT.test((err as { stderr?: string }).stderr ?? '')) throw err;
      await removeDir(dest);
      await attempt();
    }
    const { bytes } = await walkTree(dest);
    const max = options.maxBytes ?? CLONE_MAX_BYTES;
    if (bytes > max) {
      throw new Error(
        `el clon pesa ${(bytes / 1024 / 1024).toFixed(0)} MB y el tope es ${(max / 1024 / 1024).toFixed(0)} MB`,
      );
    }
  } catch (err) {
    await removeDir(dest);
    const e = err as Error & { stderr?: string; killed?: boolean };
    const detail = e.killed
      ? 'tiempo agotado'
      : (e.stderr?.trim().split('\n').pop() ?? e.message);
    throw new Error(`No se pudo clonar ${repo}: ${detail}`, { cause: err });
  }
}

/** Último commit del clon (sha y fecha ISO), leído con git sin ejecutar nada del repo. */
export async function headCommit(
  dir: string,
): Promise<{ sha: string; date: string }> {
  const { stdout } = await run(
    'git',
    ['-c', 'core.fsmonitor=false', '-C', dir, 'log', '-1', '--format=%H%n%cI'],
    { env: gitEnv(), timeout: 30_000, windowsHide: true },
  );
  const [sha, date] = stdout.trim().split('\n');
  return { sha, date };
}
