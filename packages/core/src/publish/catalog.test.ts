import { expect, test } from 'vitest';
import { catalog, readFixture } from '../testing/real-data.js';
import { parseCatalog } from '../vault/catalogo.js';
import { type NewCatalogRow, addCatalogRows } from './catalog.js';

const original = readFixture('vault/Catalogo.md');
const TODAY = '2026-10-01';

const row = (
  name: string,
  over: Partial<NewCatalogRow> = {},
): NewCatalogRow => ({
  nombre: name,
  tipo: 'plugin',
  categoria: 'claude-skills',
  semana: '2026-W40',
  score: 8,
  nota: 'Encaja con Vault Obsidian · [[2026-W40]]',
  enlace: `https://github.com/${name}`,
  ...over,
});
const rows = [
  row('acme/uno'),
  row('acme/dos', { score: 7, categoria: 'solana', tipo: 'mcp-server' }),
  row('acme/tres'),
];
const asLine = (r: NewCatalogRow) =>
  `| ${r.nombre} | ${r.tipo} | ${r.categoria} | candidato | ${r.semana} | ${r.score} | ${r.nota} | ${r.enlace} |`;

test('añade las filas al final de la tabla de hallazgos vacía sin tocar ni una línea existente', () => {
  const out = addCatalogRows(original, rows, TODAY);

  expect(out.added).toHaveLength(3);
  expect(out.skipped).toEqual([]);
  // lo único que cambia respecto al original: la línea updated y las tres filas nuevas
  const bumped = original.replace('updated: 2026-09-29', `updated: ${TODAY}`);
  const expected = `${bumped}${rows.map(asLine).join('\n')}\n`;
  expect(out.text).toBe(expected);
});

test('la tabla sigue siendo válida: 8 columnas, estado candidato y el resto de filas idénticas', () => {
  const { text } = addCatalogRows(original, rows, TODAY);
  const entries = parseCatalog(text);

  expect(entries).toHaveLength(catalog.length + 3);
  expect(entries.slice(0, catalog.length)).toEqual(catalog); // baseline intacto, con sus estados
  expect(entries.slice(catalog.length)).toEqual([
    expect.objectContaining({
      nombre: 'acme/uno',
      estado: 'candidato',
      semana: '2026-W40',
      score: 8,
      repo: 'acme/uno',
    }),
    expect.objectContaining({
      nombre: 'acme/dos',
      estado: 'candidato',
      categoria: 'solana',
      tipo: 'mcp-server',
      score: 7,
    }),
    expect.objectContaining({ nombre: 'acme/tres', estado: 'candidato' }),
  ]);
  for (const line of text.split('\n').filter((l) => l.startsWith('| acme/'))) {
    expect(line.split(/(?<!\\)\|/)).toHaveLength(10); // 8 celdas + los dos bordes
  }
});

test('con la tabla ya poblada añade tras la última fila y no altera lo que había', () => {
  const populated = `${original}| viejo/uno | plugin | claude-skills | probado | 2026-W39 | 8 | ya probado a mano | https://github.com/viejo/uno |\n| viejo/dos | tool | rust | adoptado | 2026-W39 | 9 | lo uso | https://github.com/viejo/dos |\n\nTexto posterior a la tabla.\n`;
  const { text } = addCatalogRows(populated, rows, TODAY);

  const after = text.split('\n');
  // la nota posterior sigue intacta y las filas nuevas van justo detrás de la última existente
  expect(text.endsWith('Texto posterior a la tabla.\n')).toBe(true);
  const lastExisting = after.indexOf(
    '| viejo/dos | tool | rust | adoptado | 2026-W39 | 9 | lo uso | https://github.com/viejo/dos |',
  );
  expect(after.slice(lastExisting + 1, lastExisting + 4)).toEqual(
    rows.map(asLine),
  );

  const entries = parseCatalog(text);
  expect(entries.find((e) => e.nombre === 'viejo/uno')?.estado).toBe('probado');
  expect(entries.find((e) => e.nombre === 'viejo/dos')?.estado).toBe(
    'adoptado',
  );
});

test('nunca cambia el estado de una fila existente aunque el repo vuelva a aparecer', () => {
  const populated = `${original}| acme/uno | plugin | claude-skills | adoptado | 2026-W39 | 9 | mi favorito | https://github.com/acme/uno |\n`;
  const { text, added, skipped } = addCatalogRows(
    populated,
    [row('acme/uno', { score: 10 }), row('acme/nuevo')],
    TODAY,
  );

  expect(skipped.map((r) => r.nombre)).toEqual(['acme/uno']);
  expect(added.map((r) => r.nombre)).toEqual(['acme/nuevo']);
  const entries = parseCatalog(text);
  expect(entries.filter((e) => e.nombre === 'acme/uno')).toHaveLength(1);
  expect(entries.find((e) => e.nombre === 'acme/uno')).toMatchObject({
    estado: 'adoptado',
    score: 9,
  });
});

test('es idempotente: repetirlo no añade nada ni cambia el texto', () => {
  const first = addCatalogRows(original, rows, TODAY);
  const second = addCatalogRows(first.text, rows, '2026-10-05');

  expect(second.added).toEqual([]);
  expect(second.skipped).toHaveLength(3);
  expect(second.text).toBe(first.text); // ni siquiera se sube `updated`
});

test('un repo ya presente en el baseline no se vuelve a añadir aunque cambie la forma del enlace', () => {
  const out = addCatalogRows(
    original,
    [
      row('obra/superpowers', {
        enlace: 'https://github.com/Obra/Superpowers.git',
      }),
    ],
    TODAY,
  );

  expect(out.added).toEqual([]);
  expect(out.skipped).toHaveLength(1);
  expect(out.text).toBe(original);
});

test('una fila repetida en la propia entrada se añade una vez', () => {
  const out = addCatalogRows(
    original,
    [row('acme/uno'), row('acme/uno', { score: 9 })],
    TODAY,
  );
  expect(out.added).toHaveLength(1);
  expect(out.skipped).toHaveLength(1);
});

test('las notas se escapan a una línea de tabla y se recortan a 200 caracteres', () => {
  const long = `Sirve para X | Y\ny para Z. ${'palabra '.repeat(60)}`;
  const { text } = addCatalogRows(
    original,
    [row('acme/uno', { nota: long })],
    TODAY,
  );
  const entry = parseCatalog(text).find((e) => e.nombre === 'acme/uno');

  expect(entry?.nota.startsWith('Sirve para X | Y y para Z. palabra')).toBe(
    true,
  );
  expect(entry?.nota.length).toBeLessThanOrEqual(200);
  expect(entry?.nota.endsWith('…')).toBe(true);
  expect(
    text.split('\n').filter((l) => l.startsWith('| acme/uno')),
  ).toHaveLength(1);
});

test('respeta el fin de línea CRLF de la nota', () => {
  const crlf = original.replace(/\n/g, '\r\n');
  const { text } = addCatalogRows(crlf, rows, TODAY);

  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  expect(text.replace(/\r\n/g, '\n')).toBe(
    addCatalogRows(original, rows, TODAY).text,
  );
  expect(parseCatalog(text)).toHaveLength(catalog.length + 3);
});

test('sin la sección "## Hallazgos" usa la última tabla de catálogo; sin tablas, falla', () => {
  const noHeading = original.replace('## Hallazgos', '## Otra cosa');
  expect(
    parseCatalog(addCatalogRows(noHeading, rows, TODAY).text),
  ).toHaveLength(catalog.length + 3);

  expect(() =>
    addCatalogRows('# Catálogo\n\nSin tablas.\n', rows, TODAY),
  ).toThrow('no contiene ninguna tabla');
});

test('con "## Hallazgos" no escribe en la tabla de Baseline aunque venga la última', () => {
  const swapped = original.replace(
    /(## Hallazgos\n\n)([\s\S]*)$/,
    '$1$2\n## Archivo\n\n| Nombre | Tipo | Categoría | Estado | Semana | Score | Motivo / nota | Enlace |\n|---|---|---|---|---|---|---|---|\n| viejo/x | tool | rust | descartado | 2026-W01 | 3 | nada | https://github.com/viejo/x |\n',
  );
  const { text } = addCatalogRows(swapped, [row('acme/uno')], TODAY);
  const lines = text.split('\n');

  const at = lines.indexOf(asLine(row('acme/uno')));
  expect(lines.indexOf('## Hallazgos')).toBeLessThan(at);
  expect(at).toBeLessThan(lines.indexOf('## Archivo'));
});

test('sin filas que añadir devuelve el texto tal cual', () => {
  expect(addCatalogRows(original, [], TODAY)).toEqual({
    text: original,
    added: [],
    skipped: [],
  });
});
