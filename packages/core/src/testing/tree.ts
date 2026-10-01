// Para los tests (no forma parte de la API): demostrar que un directorio no ha cambiado.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Cada fichero de `dir` con su tamaño, su fecha de modificación y su SHA-256. */
export function treeSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const stat = fs.statSync(file);
      const sha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex');
      out[path.relative(dir, file)] = `${stat.size}|${stat.mtimeMs}|${sha}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
