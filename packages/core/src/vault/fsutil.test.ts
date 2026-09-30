import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { atomicWriteFile } from './fsutil.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-fsutil-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('escribe y sobrescribe sin dejar temporales', async () => {
  const file = path.join(tmp, 'nota.md');
  await atomicWriteFile(file, 'uno ñ\n');
  await atomicWriteFile(file, 'dos — ñ\n');

  expect(fs.readFileSync(file, 'utf8')).toBe('dos — ñ\n');
  expect(fs.readdirSync(tmp)).toEqual(['nota.md']);
  expect(fs.readFileSync(file)[0]).not.toBe(0xef); // sin BOM
});

test('si el rename falla limpia el temporal y propaga el error', async () => {
  const target = path.join(tmp, 'destino');
  fs.mkdirSync(target);

  await expect(atomicWriteFile(target, 'x', { retries: 0 })).rejects.toThrow();
  expect(fs.readdirSync(tmp)).toEqual(['destino']);
});
