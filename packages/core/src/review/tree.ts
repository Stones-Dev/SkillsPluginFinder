import fs from 'node:fs/promises';
import path from 'node:path';

export type TreeFile = {
  /** Ruta relativa a la raíz del clon, con `/`. */
  path: string;
  size: number;
};

export type Tree = {
  files: TreeFile[];
  bytes: number;
  /** `true` si se cortó el recorrido por `maxFiles`. */
  truncated: boolean;
};

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * Recorre un directorio sin abrir ningún fichero ni seguir enlaces simbólicos.
 * Se salta `.git` y `node_modules` (el clon no instala nada, pero un repo puede
 * llevar los suyos commiteados).
 */
export async function walkTree(root: string, maxFiles = 50_000): Promise<Tree> {
  const files: TreeFile[] = [];
  let bytes = 0;
  let truncated = false;

  async function visit(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name), relPath);
        if (truncated) return;
      } else if (entry.isFile()) {
        const { size } = await fs.stat(path.join(dir, entry.name));
        files.push({ path: relPath, size });
        bytes += size;
      }
    }
  }

  await visit(root, '');
  return { files, bytes, truncated };
}
