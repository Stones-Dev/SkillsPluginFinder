import fs from 'node:fs/promises';
import path from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';
import { atomicWriteFile } from '../vault/fsutil.js';

/**
 * Instantánea de una fuente: lo que se recuerda entre semanas para comparar
 * (`data/awesome/`, `data/anthropic/`). El colector calcula el borrador y el
 * pipeline la escribe cuando la recogida ya terminó.
 */
export type SnapshotWrite<T extends object = object> = {
  file: string;
  /** `true` si el fichero ya existía al leerlo. */
  existed: boolean;
  snapshot: T;
};

/** `<owner>-<repo>.json` en minúsculas. */
export const snapshotFileName = (repo: string) =>
  `${repo.toLowerCase().replace('/', '-')}.json`;

/**
 * Lee una instantánea. `null` si no existe. Una que no se puede leer, no cumple
 * el esquema o es de otra fuente (mismo nombre de fichero) lanza: nunca se
 * sobrescribe lo que no se entiende.
 */
export async function readSnapshotFile<T extends { repo: string }>(
  file: string,
  repo: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${file} no es JSON válido; no se sobrescribe.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} no cumple el esquema; no se sobrescribe.`);
  }
  if (parsed.data.repo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(
      `${file} es de ${parsed.data.repo}, no de ${repo} (mismo nombre de fichero); no se sobrescribe.`,
    );
  }
  return parsed.data;
}

/**
 * Escribe las instantáneas. Con `onlyMissing` (el `--dry-run`) nunca sobrescribe
 * una que ya existe: si lo hiciera, el ensayo se comería las novedades que debe
 * ver la recogida real. Devuelve las que ha escrito.
 */
export async function writeSnapshots(
  writes: SnapshotWrite[],
  { onlyMissing = false }: { onlyMissing?: boolean } = {},
): Promise<string[]> {
  const written: string[] = [];
  for (const write of writes) {
    if (onlyMissing && write.existed) continue;
    await fs.mkdir(path.dirname(write.file), { recursive: true });
    await atomicWriteFile(
      write.file,
      `${JSON.stringify(write.snapshot, null, 2)}\n`,
    );
    written.push(write.file);
  }
  return written;
}
