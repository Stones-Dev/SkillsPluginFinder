import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CATALOG_FILE,
  INTERESTS_FILE,
  parseInterestsYaml,
} from '../config/interests.js';
import { madridDate } from '../pipeline/week.js';
import { parseCatalog } from './catalogo.js';
import { atomicWriteFile } from './fsutil.js';
import {
  extractYamlBlock,
  normalizeYaml,
  replaceYamlBlock,
  setFrontmatterUpdated,
} from './markdown.js';

export const SYNC_STATE_FILE = path.join('data', 'sync-state.json');

export type SyncResult = {
  interests: 'created' | 'unchanged' | 'vault-to-repo' | 'repo-to-vault';
  catalogEntries: number;
  catalogChanged: boolean;
};

type SyncState = {
  interestsHash: string;
  catalogHash: string;
  syncedAt: string;
};

const sha = (text: string) =>
  crypto.createHash('sha256').update(text).digest('hex');

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readState(repoDir: string): Promise<SyncState | null> {
  const raw = await readIfExists(path.join(repoDir, SYNC_STATE_FILE));
  if (raw === null) return null;
  try {
    const state = JSON.parse(raw);
    if (typeof state.interestsHash !== 'string') throw new Error('sin hash');
    return state as SyncState;
  } catch {
    throw new Error(
      `${SYNC_STATE_FILE} está corrupto: bórralo solo si estás seguro de qué lado (vault o repo) tiene los intereses correctos.`,
    );
  }
}

/** Diff de líneas (LCS) legible: solo las líneas que difieren. */
export function lineDiff(a: string, b: string, aLabel: string, bLabel: string) {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i][j] =
        x[i] === y[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
    } else if (
      j >= y.length ||
      (i < x.length && dp[i + 1][j] >= dp[i][j + 1])
    ) {
      out.push(`- ${x[i++]}`);
    } else {
      out.push(`+ ${y[j++]}`);
    }
  }
  return out.join('\n');
}

/**
 * `interests:sync` (Plan §3). Valida todo antes de escribir nada:
 * - Intereses.md (vault) ↔ interests.yaml (repo), con el hash de la última
 *   sincronización en data/sync-state.json. Si cambiaron ambos lados, aborta
 *   con diff. El YAML inválido aborta; nunca se usa una versión anterior.
 * - Catalogo.md (vault) → catalog.json (repo, solo lectura para la nube).
 */
export async function syncInterests(opts: {
  vaultDir: string;
  repoDir: string;
  now?: Date;
}): Promise<SyncResult> {
  const { vaultDir, repoDir, now = new Date() } = opts;
  const interestsMdPath = path.join(vaultDir, 'Intereses.md');
  const yamlPath = path.join(repoDir, INTERESTS_FILE);
  const catalogJsonPath = path.join(repoDir, CATALOG_FILE);

  const interestsMd = await fs.readFile(interestsMdPath, 'utf8');
  const vaultYaml = normalizeYaml(extractYamlBlock(interestsMd).body);
  parseInterestsYaml(vaultYaml, 'Intereses.md');

  const repoRaw = await readIfExists(yamlPath);
  const repoYaml = repoRaw === null ? null : normalizeYaml(repoRaw);
  if (repoYaml !== null) parseInterestsYaml(repoYaml, INTERESTS_FILE);

  const catalogMd = await fs.readFile(
    path.join(vaultDir, 'Catalogo.md'),
    'utf8',
  );
  const entries = parseCatalog(catalogMd);
  const catalogJson = `${JSON.stringify(entries, null, 2)}\n`;

  const state = await readState(repoDir);
  const vaultHash = sha(vaultYaml);
  const conflict = (why: string) =>
    new Error(
      `${why}\n${lineDiff(vaultYaml, repoYaml ?? '', 'vault (Intereses.md)', 'repo (interests.yaml)')}\nResuelve a mano: edita uno de los dos para que coincidan y vuelve a ejecutar.`,
    );

  let interests: SyncResult['interests'];
  let finalYaml = vaultYaml;

  if (repoYaml === null) {
    interests = 'created';
  } else if (sha(repoYaml) === vaultHash) {
    interests = 'unchanged';
  } else if (state === null) {
    throw conflict(
      'Existe interests.yaml pero no data/sync-state.json y difiere de Intereses.md: no se puede saber cuál es más reciente.',
    );
  } else {
    const vaultChanged = vaultHash !== state.interestsHash;
    const repoChanged = sha(repoYaml) !== state.interestsHash;
    if (vaultChanged && repoChanged) {
      throw conflict(
        'Han cambiado ambos lados (Intereses.md e interests.yaml) desde la última sincronización.',
      );
    }
    interests = vaultChanged ? 'vault-to-repo' : 'repo-to-vault';
    if (interests === 'repo-to-vault') finalYaml = repoYaml;
  }

  const previousCatalog = await readIfExists(catalogJsonPath);
  const catalogChanged = previousCatalog !== catalogJson;

  if (interests === 'created' || interests === 'vault-to-repo') {
    await atomicWriteFile(yamlPath, vaultYaml);
  } else if (interests === 'repo-to-vault') {
    const updated = setFrontmatterUpdated(
      replaceYamlBlock(interestsMd, finalYaml),
      madridDate(now),
    );
    await atomicWriteFile(interestsMdPath, updated);
  }
  if (catalogChanged) await atomicWriteFile(catalogJsonPath, catalogJson);

  // Solo se reescribe si cambió algo: `syncedAt` marca la última sincronización
  // efectiva y evita ensuciar un fichero versionado en cada ejecución.
  const nextState: SyncState = {
    interestsHash: sha(finalYaml),
    catalogHash: sha(catalogJson),
    syncedAt: now.toISOString(),
  };
  if (
    state === null ||
    state.interestsHash !== nextState.interestsHash ||
    state.catalogHash !== nextState.catalogHash
  ) {
    await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });
    await atomicWriteFile(
      path.join(repoDir, SYNC_STATE_FILE),
      `${JSON.stringify(nextState, null, 2)}\n`,
    );
  }

  return { interests, catalogEntries: entries.length, catalogChanged };
}
