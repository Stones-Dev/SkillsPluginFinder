import fs from 'node:fs/promises';
import path from 'node:path';
import { parseInterestsYaml } from '../config/interests.js';
import type { Interests } from '../config/schema.js';
import { extractYamlBlock } from './markdown.js';

export { syncInterests, type SyncResult } from './sync.js';

/** Lee y valida el bloque YAML de `Intereses.md` (fuente de verdad, Constitución §3). */
export async function readInterestsFromVault(
  vaultDir: string,
): Promise<Interests> {
  const file = await fs.readFile(path.join(vaultDir, 'Intereses.md'), 'utf8');
  return parseInterestsYaml(extractYamlBlock(file).body, 'Intereses.md');
}
