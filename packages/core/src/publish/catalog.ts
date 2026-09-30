import {
  type MdTable,
  isCatalogTable,
  parseCatalog,
  repoFromLink,
  scanTables,
} from '../vault/catalogo.js';
import { setFrontmatterUpdated } from '../vault/markdown.js';
import { cell } from './report.js';

export type NewCatalogRow = {
  nombre: string;
  tipo: string;
  categoria: string;
  semana: string;
  score: number;
  nota: string;
  enlace: string;
};

const NOTE_MAX = 200;

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** La tabla de "## Hallazgos"; si la nota no tiene esa sección, la última tabla de catálogo. */
function findingsTable(text: string): MdTable {
  const lines = text.split(/\r?\n/);
  const tables = scanTables(text).filter(isCatalogTable);
  const heading = lines.findIndex((l) => /^##\s+Hallazgos\s*$/.test(l));
  const table =
    heading >= 0
      ? tables.find((t) => t.headerLine > heading)
      : tables[tables.length - 1];
  if (!table) {
    throw new Error(
      'Catalogo.md no tiene la tabla de hallazgos (## Hallazgos con las columnas del catálogo).',
    );
  }
  return table;
}

/**
 * Añade filas `candidato` al final de la tabla de hallazgos de `Catalogo.md`.
 * Solo inserta líneas nuevas: ninguna línea existente se toca, y en particular
 * nunca la columna `estado` (la cambia el humano). Se salta lo que ya está en el
 * catálogo (mismo repositorio) y comprueba, antes de devolver, que la tabla sigue
 * siendo válida con exactamente las filas nuevas.
 */
export function addCatalogRows(
  text: string,
  rows: NewCatalogRow[],
  today: string,
): { text: string; added: NewCatalogRow[]; skipped: NewCatalogRow[] } {
  const existing = parseCatalog(text);
  const known = new Set(existing.flatMap((e) => (e.repo ? [e.repo] : [])));

  const added: NewCatalogRow[] = [];
  const skipped: NewCatalogRow[] = [];
  for (const row of rows) {
    const repo = repoFromLink(row.enlace, row.nombre);
    if (repo && known.has(repo)) {
      skipped.push(row);
      continue;
    }
    if (repo) known.add(repo);
    added.push(row);
  }
  if (added.length === 0) return { text, added, skipped };

  const table = findingsTable(text);
  const eol = text.includes('\r\n') ? '\r' : '';
  const newLines = added.map((r) => {
    const cells = [
      r.nombre,
      r.tipo,
      r.categoria,
      'candidato',
      r.semana,
      String(r.score),
      truncate(r.nota, NOTE_MAX),
      r.enlace,
    ].map(cell);
    return `| ${cells.join(' | ')} |${eol}`;
  });

  // Se parte solo por "\n": cada línea conserva su "\r" y el resto queda idéntico.
  const raw = text.split('\n');
  raw.splice(table.endLine, 0, ...newLines);
  const updated = setFrontmatterUpdated(raw.join('\n'), today);

  const check = parseCatalog(updated);
  if (check.length !== existing.length + added.length) {
    throw new Error(
      `Catalogo.md quedaría con ${check.length} filas en vez de ${existing.length + added.length}: no se escribe.`,
    );
  }
  return { text: updated, added, skipped };
}
