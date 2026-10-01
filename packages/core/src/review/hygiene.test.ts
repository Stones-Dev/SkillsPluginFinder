import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../../..');

// `data/review/` guarda clones de repos ajenos. Si entrara en git (`git add data` lo
// hacen collect.yml y evaluar-semana) o si vitest recogiera sus ficheros de test, el
// código de terceros acabaría commiteado o, peor, ejecutándose con `pnpm test`.

test('data/review/ está ignorado por git, también sus ficheros de test y de CI', () => {
  for (const file of [
    'data/review/x__y/repo/index.test.ts',
    'data/review/x__y/repo/.github/workflows/ci.yml',
    'data/review/x__y/review.md',
  ]) {
    expect(
      () => execFileSync('git', ['check-ignore', '-q', file], { cwd: root }),
      file,
    ).not.toThrow();
  }
});

test('data/ (el resto) sigue versionándose: solo se ignora data/review/', () => {
  for (const file of [
    'data/candidates/2026-W40.json',
    'data/batches/2026-W40/scoring.json',
    'data/seen.sqlite',
  ]) {
    expect(
      () => execFileSync('git', ['check-ignore', '-q', file], { cwd: root }),
      file,
    ).toThrow();
  }
});

test('vitest no recoge nada de data/ ni de las fixtures', () => {
  const config = fs.readFileSync(path.join(root, 'vitest.config.ts'), 'utf8');

  expect(config).toContain('configDefaults.exclude');
  expect(config).toContain("'data/**'");
  expect(config).toContain("'**/tests/fixtures/**'");
});
