import { formatZodError } from '../config/interests.js';
import { type CatalogEntry, catalogEntrySchema } from '../config/schema.js';

export const CATALOG_COLUMNS = [
  'Nombre',
  'Tipo',
  'Categoría',
  'Estado',
  'Semana',
  'Score',
  'Motivo / nota',
  'Enlace',
] as const;

export type MdTable = {
  /** Índices de línea (0-based) sobre `text.split(/\r?\n/)`. */
  headerLine: number;
  firstRow: number;
  /** Exclusivo: primera línea posterior a la tabla. */
  endLine: number;
  header: string[];
  rows: { line: number; cells: string[] }[];
};

/** Separa una fila `| a | b |` respetando `\|` dentro de las celdas. */
export function splitRow(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const SEPARATOR = /^\|[\s:|-]+\|?\s*$/;

/** Localiza todas las tablas Markdown de una nota. */
export function scanTables(text: string): MdTable[] {
  const lines = text.split(/\r?\n/);
  const tables: MdTable[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|') || !SEPARATOR.test(lines[i + 1] ?? '')) {
      continue;
    }
    const rows: MdTable['rows'] = [];
    let j = i + 2;
    while (j < lines.length && lines[j].startsWith('|')) {
      rows.push({ line: j, cells: splitRow(lines[j]) });
      j++;
    }
    tables.push({
      headerLine: i,
      firstRow: i + 2,
      endLine: j,
      header: splitRow(lines[i]),
      rows,
    });
    i = j - 1;
  }
  return tables;
}

const norm = (s: string) => s.normalize('NFC').trim().toLowerCase();

export function isCatalogTable(table: MdTable): boolean {
  return (
    table.header.length === CATALOG_COLUMNS.length &&
    CATALOG_COLUMNS.every((c, k) => norm(c) === norm(table.header[k]))
  );
}

const dash = (v: string): string | null =>
  v === '' || v === '—' || v === '-' ? null : v;

/** `owner/repo` en minúsculas a partir del enlace de GitHub o del nombre. */
export function repoFromLink(
  enlace: string | null,
  nombre: string,
): string | null {
  const gh = enlace?.match(/github\.com\/([^/\s)>]+)\/([^/\s)>#?]+)/i);
  if (gh) return `${gh[1]}/${gh[2].replace(/\.git$/i, '')}`.toLowerCase();
  if (/^[\w.-]+\/[\w.-]+$/.test(nombre)) return nombre.toLowerCase();
  return null;
}

/** Todas las filas de todas las tablas de catálogo (Baseline + Hallazgos). */
export function parseCatalog(text: string): CatalogEntry[] {
  const tables = scanTables(text).filter(isCatalogTable);
  if (tables.length === 0) {
    throw new Error(
      `Catalogo.md no contiene ninguna tabla con las columnas ${CATALOG_COLUMNS.join(' | ')}.`,
    );
  }

  const entries: CatalogEntry[] = [];
  for (const table of tables) {
    for (const { line, cells } of table.rows) {
      const where = `Catalogo.md línea ${line + 1}`;
      if (cells.length !== CATALOG_COLUMNS.length) {
        throw new Error(
          `${where}: se esperaban ${CATALOG_COLUMNS.length} columnas y hay ${cells.length}.`,
        );
      }
      const [nombre, tipo, categoria, estado, semana, score, nota, enlace] =
        cells;
      const scoreRaw = dash(score);
      const scoreNum = scoreRaw === null ? null : Number(scoreRaw);
      if (scoreNum !== null && Number.isNaN(scoreNum)) {
        throw new Error(`${where}: score no numérico (${scoreRaw}).`);
      }
      const link = dash(enlace);
      const parsed = catalogEntrySchema.safeParse({
        nombre,
        tipo,
        categoria,
        estado: estado.toLowerCase(),
        semana,
        score: scoreNum,
        nota,
        enlace: link,
        repo: repoFromLink(link, nombre),
      });
      if (!parsed.success) {
        throw new Error(`${where}: ${formatZodError(parsed.error)}`);
      }
      entries.push(parsed.data);
    }
  }
  return entries;
}
