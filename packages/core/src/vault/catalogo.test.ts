import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  isCatalogTable,
  parseCatalog,
  repoFromLink,
  scanTables,
  splitRow,
} from './catalogo.js';

const md = fs
  .readFileSync(
    path.resolve(import.meta.dirname, '../../tests/fixtures/vault/Catalogo.md'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');

const HEADER =
  '| Nombre | Tipo | Categoría | Estado | Semana | Score | Motivo / nota | Enlace |\n|---|---|---|---|---|---|---|---|\n';
const table = (...rows: string[]) => `${HEADER}${rows.join('\n')}\n`;

test('parsea Baseline y Hallazgos de la nota real', () => {
  const entries = parseCatalog(md);

  expect(entries).toHaveLength(9);
  expect(
    entries.filter((e) => e.estado === 'descartado').map((e) => e.nombre),
  ).toEqual(['obra/superpowers', 'garrytan/gstack', 'thedotmack/claude-mem']);
  expect(entries.filter((e) => e.estado === 'adoptado')).toHaveLength(6);
  expect(entries[0]).toEqual({
    nombre: 'obra/superpowers',
    tipo: 'plugin',
    categoria: 'claude-skills',
    estado: 'descartado',
    semana: 'baseline',
    score: null,
    nota: 'Choca con SDD estricto (ver nota de descartes)',
    enlace: 'https://github.com/obra/superpowers',
    repo: 'obra/superpowers',
  });
  expect(
    entries.find((e) => e.nombre.startsWith('Frontend Design')),
  ).toMatchObject({ enlace: null, repo: null, score: null });
});

test('localiza las dos tablas y la de Hallazgos está vacía', () => {
  const tables = scanTables(md);
  expect(tables).toHaveLength(2);
  expect(tables.every(isCatalogTable)).toBe(true);
  expect(tables[0].rows).toHaveLength(9);
  expect(tables[1].rows).toHaveLength(0);
  expect(tables[1].endLine).toBe(tables[1].firstRow);
});

test('tolera CRLF', () => {
  expect(parseCatalog(md.replace(/\n/g, '\r\n'))).toEqual(parseCatalog(md));
});

test('respeta el pipe escapado dentro de una celda', () => {
  expect(splitRow('| a | b \\| c | d |')).toEqual(['a', 'b | c', 'd']);
  const [entry] = parseCatalog(
    table(
      '| x/y | tool | mcp-servers | candidato | 2026-W40 | 8 | uno \\| dos | https://github.com/x/y |',
    ),
  );
  expect(entry.nota).toBe('uno | dos');
  expect(entry.score).toBe(8);
});

test('errores con número de línea', () => {
  expect(() => parseCatalog(table('| a | b |'))).toThrow(
    'línea 3: se esperaban 8 columnas y hay 2',
  );
  expect(() =>
    parseCatalog(table('| a | t | c | quizás | s | — | n | — |')),
  ).toThrow('línea 3');
  expect(() =>
    parseCatalog(table('| a | t | c | candidato | s | alto | n | — |')),
  ).toThrow('score no numérico');
  expect(() => parseCatalog('# sin tablas\n')).toThrow(
    'no contiene ninguna tabla',
  );
});

test('repoFromLink deduce owner/repo en minúsculas', () => {
  expect(repoFromLink('https://github.com/Owner/Repo.git', 'x')).toBe(
    'owner/repo',
  );
  expect(repoFromLink('[x](https://github.com/a/b)', 'x')).toBe('a/b');
  expect(repoFromLink(null, 'Foo/Bar')).toBe('foo/bar');
  expect(repoFromLink(null, 'Frontend Design (Anthropic)')).toBeNull();
  expect(repoFromLink('https://example.com/x', 'x/y')).toBe('x/y');
});
