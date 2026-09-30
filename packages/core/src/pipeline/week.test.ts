import { expect, test } from 'vitest';
import { assertWeek, isoWeek } from './week.js';

test.each([
  ['2026-09-30T12:00:00Z', '2026-W40'], // miércoles
  ['2026-09-28T00:00:00+02:00', '2026-W40'], // lunes 00:00 en Madrid (CEST)
  ['2026-09-27T21:30:00Z', '2026-W39'], // domingo 23:30 en Madrid
  ['2026-09-27T22:30:00Z', '2026-W40'], // aún domingo en UTC, ya lunes 00:30 en Madrid
  ['2026-01-01T12:00:00Z', '2026-W01'], // el jueves 1 de enero abre la semana 1
  ['2025-12-29T12:00:00Z', '2026-W01'], // lunes de finales de 2025 ya es del año ISO 2026
  ['2027-01-01T12:00:00Z', '2026-W53'], // viernes: sigue en la semana 53 de 2026
  ['2027-01-04T12:00:00Z', '2027-W01'],
  ['2021-01-03T12:00:00Z', '2020-W53'],
  ['2024-12-30T12:00:00Z', '2025-W01'],
  ['2026-03-29T00:30:00Z', '2026-W13'], // cambio de hora (CET → CEST)
])('isoWeek(%s) = %s', (instant, week) => {
  expect(isoWeek(new Date(instant))).toBe(week);
});

test('isoWeek respeta la zona horaria pedida', () => {
  const instant = new Date('2026-09-27T22:30:00Z');
  expect(isoWeek(instant, 'Europe/Madrid')).toBe('2026-W40');
  expect(isoWeek(instant, 'UTC')).toBe('2026-W39');
});

test('assertWeek acepta YYYY-Www y rechaza el resto', () => {
  expect(assertWeek('2026-W40')).toBe('2026-W40');
  for (const bad of ['2026-40', '2026-W4', '26-W40', '../etc', '']) {
    expect(() => assertWeek(bad)).toThrow('Semana inválida');
  }
});
