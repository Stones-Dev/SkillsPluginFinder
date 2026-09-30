import { expect, test } from 'vitest';
import { cloddsBot, realCandidates } from '../testing/real-data.js';
import type { Candidate } from './candidate.js';
import { YOUNG_REPO_DAYS, riskSignals } from './risk.js';

const texts = (c: Candidate) =>
  riskSignals(c).map((s) => `${s.level}: ${s.text}`);

test('CloddsBot (datos reales): avisa del postinstall y muestra el resto como contexto', () => {
  const signals = texts(cloddsBot());

  expect(signals).toContain(
    'warn: package.json ejecuta scripts al instalar: postinstall',
  );
  expect(signals).toContain('info: 4 contribuidores');
  expect(signals).toContain('info: Licencia MIT');
  // created_at 2026-01-26T15:08:42Z → 246,87 días hasta 2026-09-30T12:00Z
  expect(signals).toContain('info: Creado hace 246 días');
  expect(signals.some((s) => s.startsWith('info: Último push hace '))).toBe(
    true,
  );
  expect(signals.filter((s) => s.startsWith('warn'))).toHaveLength(1);
});

test('un repo joven, con un único contribuidor y sin licencia reconocida acumula avisos', () => {
  const base = cloddsBot();
  const c: Candidate = {
    ...base,
    license: undefined,
    contributors: 1,
    risk: {
      ...base.risk,
      ageDays: YOUNG_REPO_DAYS - 1,
      singleMaintainer: true,
      postinstall: undefined,
      lifecycleScripts: undefined,
      notes: ['README no disponible: Not Found'],
    },
  };
  const signals = texts(c);

  expect(signals).toContain('warn: Repo joven: creado hace 29 días');
  expect(signals).toContain('warn: Un único contribuidor');
  expect(signals).toContain('warn: Licencia no reconocida');
  expect(signals).toContain(
    'info: package.json no comprobado (no hay uno en la raíz o falló la consulta)',
  );
  expect(signals).toContain('info: README no disponible: Not Found');
});

test('el límite de "joven" es exclusivo y lo desconocido no es un aviso', () => {
  const base = cloddsBot();
  const at = (ageDays: number) => ({
    ...base,
    risk: { ...base.risk, ageDays },
  });
  expect(texts(at(YOUNG_REPO_DAYS))).toContain(
    `info: Creado hace ${YOUNG_REPO_DAYS} días`,
  );

  const unknown: Candidate = {
    ...base,
    contributors: undefined,
    risk: {
      ...base.risk,
      singleMaintainer: undefined,
      postinstall: false,
      lifecycleScripts: [],
    },
  };
  const signals = texts(unknown);
  expect(signals).toContain('info: Contribuidores: desconocido');
  expect(signals).toContain('info: Sin scripts de instalación en package.json');
  expect(signals.filter((s) => s.startsWith('warn'))).toEqual([]);
});

test('es determinista y nunca da días negativos aunque el push sea posterior al hallazgo', () => {
  const future = realCandidates().find(
    (c) => c.name === 'FlorianBruniaux/claude-code-ultimate-guide',
  );
  if (!future) throw new Error('falta el repo del fixture');

  expect(riskSignals(future)).toEqual(riskSignals(future));
  expect(texts(future)).toContain('info: Último push hace 0 días');
});
