import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { reviewFixtures } from '../testing/git-repo.js';
import { insertOpenLoop, planOpenLoop } from './daily.js';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(reviewFixtures, '../vault', rel), 'utf8');
const daily = read('Diario-2026-10-01.md');
const template = read('Plantilla-Diario.md');
const LINE = '- [[SkillsPluginFinder]]: `github:a/b` se queda en `probado`.';

test('la línea entra al final de «Bucles abiertos», tras los bucles existentes y antes de la sección siguiente', () => {
  const out = insertOpenLoop(daily, LINE).split('\n');

  const i = out.indexOf(LINE);
  expect(out[i - 1]).toMatch(/^- Las copias de/);
  expect(out[i + 1]).toBe('');
  expect(out[i + 2]).toBe('## Notas del día');
  // todo lo demás, idéntico
  expect(out.filter((l) => l !== LINE)).toEqual(daily.split('\n'));
});

test('con la sección vacía (solo la frase de ayuda) la línea va justo debajo', () => {
  const out = insertOpenLoop(
    template.replaceAll('YYYY-MM-DD', '2026-10-02'),
    LINE,
  ).split('\n');

  const i = out.indexOf(LINE);
  expect(out[i - 1]).toBe(
    '_Tareas o problemas que siguen en curso de días anteriores._',
  );
  expect(out.indexOf('## Notas del día')).toBeGreaterThan(i);
});

test('la misma línea no se añade dos veces', () => {
  const once = insertOpenLoop(daily, LINE);

  expect(insertOpenLoop(once, LINE)).toBe(once);
});

test('si la nota no tiene «Bucles abiertos», se crea la sección al final', () => {
  const out = insertOpenLoop('# Hoy\n\nAlgo.\n', LINE);

  expect(out).toBe(`# Hoy\n\nAlgo.\n\n## Bucles abiertos\n\n${LINE}\n`);
});

test('respeta CRLF', () => {
  const crlf = daily.replace(/\n/g, '\r\n');

  const out = insertOpenLoop(crlf, LINE);

  expect(
    out
      .split('\n')
      .every((l, i, all) => i === all.length - 1 || l.endsWith('\r')),
  ).toBe(true);
  expect(out.replace(/\r\n/g, '\n')).toBe(insertOpenLoop(daily, LINE));
});

let vault: string;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-daily-'));
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

test('planOpenLoop crea la nota del día desde la plantilla del vault, con la fecha puesta', async () => {
  fs.mkdirSync(path.join(vault, '99-Meta', 'Plantillas'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '99-Meta', 'Plantillas', 'Plantilla Diario.md'),
    template,
  );

  const plan = await planOpenLoop(vault, '2026-10-02', LINE);

  expect(plan.created).toBe(true);
  expect(plan.file).toBe(path.join(vault, '01-Diario', '2026-10-02.md'));
  expect(plan.text).toContain('created: 2026-10-02');
  expect(plan.text).toContain('# 2026-10-02');
  expect(plan.text).not.toContain('YYYY-MM-DD');
  expect(plan.text).toContain(LINE);
  // no escribe: eso lo hace quien llama, tras validar todo
  expect(fs.existsSync(plan.file)).toBe(false);
});

test('planOpenLoop sin plantilla usa el esqueleto del diario', async () => {
  const plan = await planOpenLoop(vault, '2026-10-02', LINE);

  expect(plan.created).toBe(true);
  expect(plan.text).toContain('type: diario');
  expect(plan.text).toContain(LINE);
});

test('planOpenLoop sobre una nota existente sube updated y añade la línea', async () => {
  fs.mkdirSync(path.join(vault, '01-Diario'));
  fs.writeFileSync(path.join(vault, '01-Diario', '2026-10-02.md'), daily);

  const plan = await planOpenLoop(vault, '2026-10-02', LINE);

  expect(plan.created).toBe(false);
  expect(plan.text).toContain('updated: 2026-10-02');
  expect(plan.text).toContain(LINE);
});
