import fs from 'node:fs';
import path from 'node:path';

/**
 * Raíz del repo = directorio desde el que se lanza `spf` (Constitución §4: nada
 * depende de rutas absolutas ni de la estructura del entorno). Se valida con
 * `pnpm-workspace.yaml` para fallar en voz alta si se ejecuta desde otra carpeta.
 */
export function repoRoot(cwd: string = process.cwd()): string {
  if (!fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
    throw new Error(
      `spf debe ejecutarse desde la raíz del repo (no hay pnpm-workspace.yaml en ${cwd}). Usa "pnpm spf <comando>" desde la raíz.`,
    );
  }
  return cwd;
}

/**
 * Carpeta del proyecto en el vault (`02-Proyectos/SkillsPluginFinder`), solo
 * por `VAULT_PATH`. Nunca hay una copia del vault dentro del repo.
 */
export function vaultPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.VAULT_PATH;
  if (!raw) {
    throw new Error(
      'VAULT_PATH es obligatorio: ruta de la carpeta del proyecto en el vault (ver .env.example).',
    );
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(path.join(resolved, 'Intereses.md'))) {
    throw new Error(
      `VAULT_PATH (${resolved}) no contiene Intereses.md: debe apuntar a la carpeta 02-Proyectos/SkillsPluginFinder del vault.`,
    );
  }
  return resolved;
}
