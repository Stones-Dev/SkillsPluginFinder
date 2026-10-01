import type { CatalogEntry } from '../config/schema.js';
import { cell } from '../publish/report.js';
import {
  isCatalogTable,
  parseCatalog,
  repoFromLink,
  scanTables,
  splitRow,
} from '../vault/catalogo.js';
import { setFrontmatterUpdated } from '../vault/markdown.js';

export type RowPatch = {
  estado?: CatalogEntry['estado'];
  score?: number;
  /** Texto completo de la celda `Motivo / nota` (sustituye al actual). */
  nota?: string;
};

const dash = (v: string) => (v === '' || v === '—' || v === '-' ? null : v);

/**
 * Edita una sola fila de `Catalogo.md` (la del repositorio `repo`) y nada más:
 * las demás líneas quedan idénticas byte a byte (salvo `updated:` del frontmatter),
 * se conserva el fin de línea del fichero y se vuelve a parsear el resultado
 * comprobando que solo cambió esa fila. Es la contrapartida de `addCatalogRows`,
 * que solo inserta; este solo modifica, y solo las columnas `Estado`, `Score` y
 * `Motivo / nota`.
 */
export function editCatalogRow(
  text: string,
  repo: string,
  patch: RowPatch,
  today: string,
): { text: string; before: CatalogEntry; after: CatalogEntry } {
  const entries = parseCatalog(text);
  const lines = scanTables(text)
    .filter(isCatalogTable)
    .flatMap((t) => t.rows.map((r) => ({ line: r.line, cells: r.cells })));

  const matches = entries
    .map((e, i) => (e.repo === repo ? i : -1))
    .filter((i) => i >= 0);
  if (matches.length === 0) {
    throw new Error(`${repo} no está en Catalogo.md.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${repo} aparece ${matches.length} veces en Catalogo.md: no se sabe qué fila editar.`,
    );
  }
  const index = matches[0];
  const { line, cells } = lines[index];
  if (repoFromLink(dash(cells[7]), cells[0]) !== repo) {
    throw new Error(
      'Catalogo.md: las filas parseadas no casan con las líneas.',
    );
  }

  const next = [...cells];
  if (patch.estado !== undefined) next[3] = patch.estado;
  if (patch.score !== undefined) next[5] = String(patch.score);
  if (patch.nota !== undefined) next[6] = patch.nota;

  const original = text.split('\n');
  const eol = original[line].endsWith('\r') ? '\r' : '';
  const edited = [...original];
  edited[line] = `| ${next.map(cell).join(' | ')} |${eol}`;
  const updatedText = setFrontmatterUpdated(edited.join('\n'), today);

  // Solo puede haber cambiado la fila editada y, como mucho, `updated:` del frontmatter.
  const after = updatedText.split('\n');
  const changed = after
    .map((l, i) => (l === original[i] ? -1 : i))
    .filter((i) => i >= 0 && i !== line);
  const frontmatterEnd = original.findIndex(
    (l, i) => i > 0 && /^---\s*$/.test(l),
  );
  if (
    after.length !== original.length ||
    changed.some((i) => !(i < frontmatterEnd && /^updated:/.test(after[i])))
  ) {
    throw new Error(
      'Catalogo.md: la edición habría tocado algo más que la fila pedida; no se escribe.',
    );
  }

  const check = parseCatalog(updatedText);
  if (check.length !== entries.length) {
    throw new Error(
      `Catalogo.md quedaría con ${check.length} filas en vez de ${entries.length}: no se escribe.`,
    );
  }
  for (let i = 0; i < entries.length; i++) {
    if (i === index) continue;
    if (JSON.stringify(check[i]) !== JSON.stringify(entries[i])) {
      throw new Error(
        `Catalogo.md: la fila ${entries[i].nombre} habría cambiado; no se escribe.`,
      );
    }
  }
  return { text: updatedText, before: entries[index], after: check[index] };
}
