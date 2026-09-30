import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  extractYamlBlock,
  normalizeYaml,
  replaceYamlBlock,
  setFrontmatterUpdated,
} from './markdown.js';

const md = fs
  .readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../tests/fixtures/vault/Intereses.md',
    ),
    'utf8',
  )
  .replace(/\r\n/g, '\n');

test('extractYamlBlock devuelve el cuerpo del único bloque de la nota real', () => {
  const { body } = extractYamlBlock(md);
  expect(body.startsWith('version: 1\n')).toBe(true);
  expect(body.endsWith('operando vía Local REST API\n')).toBe(true);
  expect(body).not.toContain('```');
});

const BOM = String.fromCharCode(0xfeff);

test('tolera CRLF y BOM', () => {
  const crlf = BOM + md.replace(/\n/g, '\r\n');
  expect(normalizeYaml(extractYamlBlock(crlf).body)).toBe(
    normalizeYaml(extractYamlBlock(md).body),
  );
});

test('setFrontmatterUpdated conserva el BOM inicial', () => {
  const out = setFrontmatterUpdated(BOM + md, '2026-10-01');
  expect(out.startsWith(`${BOM}---\n`)).toBe(true);
  expect(out).toContain('updated: 2026-10-01');
});

test('exige exactamente un bloque yaml', () => {
  expect(() => extractYamlBlock('# sin bloque\n')).toThrow('hay 0');
  expect(() => extractYamlBlock(`${md}\n\`\`\`yaml\na: 1\n\`\`\`\n`)).toThrow(
    'hay 2',
  );
  expect(() => extractYamlBlock('```yaml\na: 1\n')).toThrow('sin cerrar');
});

test('replaceYamlBlock no toca nada fuera del bloque', () => {
  const { start, end } = extractYamlBlock(md);
  const out = replaceYamlBlock(md, 'version: 1\numbral_score: 9\n');

  expect(out.slice(0, start)).toBe(md.slice(0, start));
  expect(out.slice(out.length - (md.length - end))).toBe(md.slice(end));
  expect(out).toContain('```yaml\nversion: 1\numbral_score: 9\n```');
});

test('replaceYamlBlock conserva el fin de línea CRLF de la nota', () => {
  const out = replaceYamlBlock(md.replace(/\n/g, '\r\n'), 'a: 1\nb: 2\n');
  expect(out).toContain('```yaml\r\na: 1\r\nb: 2\r\n```');
  expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
});

test('setFrontmatterUpdated cambia solo la línea updated', () => {
  const out = setFrontmatterUpdated(md, '2026-10-01');
  expect(out).toContain('updated: 2026-10-01');
  expect(out.replace('updated: 2026-10-01', 'updated: 2026-09-29')).toBe(md);
});

test('setFrontmatterUpdated no toca notas sin frontmatter', () => {
  expect(
    setFrontmatterUpdated('# Solo texto\nupdated: x\n', '2026-10-01'),
  ).toBe('# Solo texto\nupdated: x\n');
});
