import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';
import type { ZodError } from 'zod';
import {
  type CatalogEntry,
  type Interests,
  catalogSchema,
  interestsSchema,
} from './schema.js';

/** Espejos de la nota del vault que lee la mitad nube (Plan §3). */
export const INTERESTS_FILE = 'interests.yaml';
export const CATALOG_FILE = 'catalog.json';

export function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
    .join('; ');
}

/**
 * Las líneas de `proyectos` son texto libre ("Nombre — descripción: detalle").
 * YAML lee `Solana: Yellowstone` dentro de un plain scalar como un mapa de un
 * solo par, así que se recupera el texto literal de la fuente en vez de
 * serializar el mapa. Cualquier otra forma estructurada se deja tal cual para
 * que el esquema la rechace señalando su posición.
 */
function projectLine(source: string, item: unknown): unknown {
  if (yaml.isScalar(item)) return item.value;
  if (
    yaml.isMap(item) &&
    item.range &&
    item.items.length === 1 &&
    yaml.isScalar(item.items[0].key) &&
    yaml.isScalar(item.items[0].value)
  ) {
    return source
      .slice(item.range[0], item.range[1])
      .replace(/\s+/g, ' ')
      .trim();
  }
  return yaml.isNode(item) ? item.toJSON() : item;
}

/**
 * Parsea y valida el YAML de intereses. Un YAML inválido aborta con un mensaje
 * claro: nunca se cae en silencio a una versión anterior (RF-8).
 */
export function parseInterestsYaml(
  text: string,
  origin = 'YAML de intereses',
): Interests {
  const doc = yaml.parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(
      `${origin} inválido: ${doc.errors.map((e) => e.message).join('; ')}`,
    );
  }

  const data = doc.toJS();
  if (yaml.isMap(doc.contents) && data && typeof data === 'object') {
    const proyectos = doc.get('proyectos', true);
    if (yaml.isSeq(proyectos)) {
      data.proyectos = proyectos.items.map((item) => projectLine(text, item));
    }
  }

  const parsed = interestsSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `${origin} no cumple el esquema: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

async function readMirror(repoDir: string, file: string): Promise<string> {
  try {
    return await fs.readFile(path.join(repoDir, file), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No existe ${file}: ejecuta "pnpm spf interests sync" para generarlo desde el vault.`,
      );
    }
    throw err;
  }
}

/** Intereses tal y como los ve la nube: solo el espejo del repo. */
export async function loadInterests(repoDir: string): Promise<Interests> {
  return parseInterestsYaml(
    await readMirror(repoDir, INTERESTS_FILE),
    INTERESTS_FILE,
  );
}

/** Estados del catálogo tal y como los ve la nube: solo el espejo del repo. */
export async function loadCatalog(repoDir: string): Promise<CatalogEntry[]> {
  const raw = await readMirror(repoDir, CATALOG_FILE);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${CATALOG_FILE} no es JSON válido.`);
  }
  const parsed = catalogSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${CATALOG_FILE} no cumple el esquema: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}
