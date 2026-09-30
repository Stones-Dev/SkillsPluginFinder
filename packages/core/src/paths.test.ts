import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { repoRoot, vaultPath } from './paths.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-paths-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('repoRoot es process.cwd() cuando se ejecuta desde la raíz del repo', () => {
  expect(repoRoot()).toBe(process.cwd());
});

test('repoRoot falla fuera de la raíz del repo', () => {
  expect(() => repoRoot(tmp)).toThrow('desde la raíz del repo');
});

test('repoRoot acepta un directorio con pnpm-workspace.yaml', () => {
  fs.writeFileSync(path.join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n');
  expect(repoRoot(tmp)).toBe(tmp);
});

test('vaultPath exige VAULT_PATH', () => {
  expect(() => vaultPath({})).toThrow('VAULT_PATH es obligatorio');
});

test('vaultPath exige que la carpeta contenga Intereses.md', () => {
  expect(() => vaultPath({ VAULT_PATH: tmp })).toThrow(
    'no contiene Intereses.md',
  );
});

test('vaultPath devuelve la ruta resuelta cuando existe Intereses.md', () => {
  fs.writeFileSync(path.join(tmp, 'Intereses.md'), '---\n---\n');
  expect(vaultPath({ VAULT_PATH: tmp })).toBe(path.resolve(tmp));
});
