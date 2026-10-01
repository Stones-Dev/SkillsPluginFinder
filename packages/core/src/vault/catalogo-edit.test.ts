import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { reviewFixtures } from '../testing/git-repo.js';
import { editCatalogRow } from './catalogo-edit.js';
import { parseCatalog } from './catalogo.js';

const text = fs
  .readFileSync(
    path.resolve(reviewFixtures, '../vault/Catalogo-W40.md'),
    'utf8',
  )
  .replace(/\r\n/g, '\n');
const REPO = 'solanabr/ai-kit';

test('cambia solo el estado de la fila pedida; el resto del fichero queda igual', () => {
  const r = editCatalogRow(text, REPO, { estado: 'probado' }, '2026-10-02');

  expect(r.before.estado).toBe('candidato');
  expect(r.after.estado).toBe('probado');
  expect(r.after.nota).toBe(r.before.nota);
  const a = text.split('\n');
  const b = r.text.split('\n');
  expect(b).toHaveLength(a.length);
  const diff = b.flatMap((l, i) => (l === a[i] ? [] : [i]));
  expect(diff.map((i) => b[i].slice(0, 12))).toEqual([
    'updated: 202',
    '| solanabr/a',
  ]);
  expect(parseCatalog(r.text).filter((e) => e.repo !== REPO)).toEqual(
    parseCatalog(text).filter((e) => e.repo !== REPO),
  );
});

test('la edición de la fila no cambia sus demás columnas', () => {
  const r = editCatalogRow(text, REPO, { estado: 'descartado' }, '2026-10-02');

  const { estado: _e, ...restAfter } = r.after;
  const { estado: _b, ...restBefore } = r.before;
  expect(restAfter).toEqual(restBefore);
});

test('puede cambiar el score y la nota, escapando el pipe', () => {
  const r = editCatalogRow(
    text,
    REPO,
    { score: 6.5, nota: 'a | b\nsegunda línea' },
    '2026-10-02',
  );

  expect(r.after.score).toBe(6.5);
  expect(r.after.nota).toBe('a | b segunda línea');
  expect(r.text).toContain('a \\| b segunda línea');
});

test('conserva los finales de línea CRLF del fichero', () => {
  const crlf = text.replace(/\n/g, '\r\n');

  const r = editCatalogRow(crlf, REPO, { estado: 'probado' }, '2026-10-02');

  expect(
    r.text
      .split('\n')
      .every((l, i, all) => i === all.length - 1 || l.endsWith('\r')),
  ).toBe(true);
  expect(parseCatalog(r.text).find((e) => e.repo === REPO)?.estado).toBe(
    'probado',
  );
});

test('una fila del baseline también se puede editar con la misma garantía (aunque apply no lo permita)', () => {
  const r = editCatalogRow(
    text,
    'obra/superpowers',
    { nota: 'x' },
    '2026-10-02',
  );

  expect(
    parseCatalog(r.text).filter((e) => e.semana === 'baseline'),
  ).toHaveLength(9);
  expect(r.after.nota).toBe('x');
});

test('un repositorio que no está o que está repetido se rechaza', () => {
  expect(() =>
    editCatalogRow(text, 'nadie/nada', { estado: 'probado' }, '2026-10-02'),
  ).toThrow('nadie/nada no está en Catalogo.md.');
  const dup = `${text.trimEnd()}\n| ai-kit otra vez | skill | solana | candidato | 2026-W41 | 7 | n | https://github.com/solanabr/ai-kit |\n`;
  expect(() =>
    editCatalogRow(dup, REPO, { estado: 'probado' }, '2026-10-02'),
  ).toThrow(/aparece 2 veces/);
});
