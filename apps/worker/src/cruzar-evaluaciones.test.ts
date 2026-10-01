import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const claude = read('.claude/commands/cruzar-evaluaciones.md');
const antigravity = read('.agent/workflows/cruzar-evaluaciones.md');
const evaluar = read('.agent/workflows/evaluar-semana.md');
const cli = read('apps/worker/src/cli.ts');
const cross = read('packages/core/src/cross/cross.ts');

const withoutFrontmatter = (text: string) =>
  text.replace(/^---\n[\s\S]*?\n---\n\n/, '');

test('los dos workflows dicen exactamente lo mismo (el de Claude Code solo añade frontmatter)', () => {
  expect(withoutFrontmatter(claude)).toBe(antigravity);
  expect(antigravity.startsWith('---')).toBe(false);
  const frontmatter = claude.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  expect(frontmatter).toContain('description: ');
  expect(frontmatter).toContain('argument-hint: "[YYYY-Www]"');
  expect(claude).toContain('`$ARGUMENTS`');
});

test('cada `pnpm spf …` que cita el workflow es un comando real del CLI', () => {
  const declared = new Set(
    [...cli.matchAll(/\.command\('([a-z-]+)'\)/g)].map((m) => m[1]),
  );
  const cited = [...antigravity.matchAll(/pnpm spf ([a-z-]+)/g)].map(
    (m) => m[1],
  );

  expect(cited).toEqual(
    expect.arrayContaining(['week', 'cross', 'publish', 'review', 'interests']),
  );
  for (const command of cited) {
    expect(declared.has(command), `pnpm spf ${command} no existe`).toBe(true);
  }
  expect(cli).toContain("'--force'");
  expect(antigravity).toContain('--force');
});

test('el flujo: comprobar → cruzar → publicar solo si cambia → sincronizar → commit → resumen', () => {
  const at = (needle: string) => antigravity.indexOf(needle);
  const order = [
    '1. **Comprobar lo que hay.**',
    'pnpm spf cross --week <semana>',
    '3. **Publicar solo si cambia.**',
    'pnpm spf publish --week <semana>',
    'pnpm spf interests sync',
    'git commit -m "feat(evaluate): cruce de la semana <semana>"',
    '7. **Resumen para Stones.**',
  ];
  const positions = order.map(at);
  expect(
    positions.every((p) => p >= 0),
    JSON.stringify(order.filter((_, i) => positions[i] < 0)),
  ).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test('las reglas del cruce coinciden con las del código: umbral de disputa, confianza alta y marcas', () => {
  expect(cross).toContain('DISPUTA_DELTA = 3');
  expect(cross).toContain('CONFIANZA_ALTA_MIN = 7');
  expect(antigravity).toContain('`disputa` si difieren en 3 o más puntos');
  expect(antigravity).toContain('`confianza alta` si los dos llegan a 7');
  expect(antigravity).toContain('`⚖ disputa …`');
  expect(antigravity).toContain('`✓ confianza alta …`');
  expect(cross).toContain("DISPUTA_MARK = '⚖ disputa'");
  expect(cross).toContain("CONFIANZA_MARK = '✓ confianza alta'");
  expect(antigravity).toContain('bloquea `adoptado`');
});

test('--force solo con motivo: informe revisado, el cruce dice que cambia y copia previa', () => {
  expect(antigravity).toContain('`--force` solo con motivo');
  expect(antigravity).toContain('revisado: true');
  expect(antigravity).toContain('«publicación: cambia»');
  expect(antigravity).toContain('una copia del informe actual en `data/logs/`');
  // la línea que lee el workflow la imprime de verdad `spf cross`
  expect(cross).toContain('publicación: cambia');
  expect(cross).toContain('publicación: sin cambios');
});

test('respeta lo decidido y no toca los scorings', () => {
  expect(antigravity).toContain(
    '`probado`, `adoptado` o `descartado` no se toca',
  );
  expect(antigravity).toContain(
    'No reevalúes ni edites ningún `scoring*.json`',
  );
  expect(antigravity).toContain('No hagas `git push` ni pongas tags');
  expect(antigravity).toContain('Pega la salida de cada `pnpm spf`');
});

test('evaluar-semana cruza antes de publicar, no repite la semana revisada y encadena la revisión', () => {
  expect(evaluar).toContain('**Cruzar.** `pnpm spf cross --week <semana>`');
  expect(evaluar).toContain('el workflow `cruzar-evaluaciones`');
  expect(evaluar).toContain('Sigue el workflow `revisar-hallazgos`');
  expect(evaluar).toContain('`--week <semana>`');
  expect(evaluar).toContain(
    'una disputa entre los dos evaluadores bloquea `adoptado`',
  );
  // y ninguno de los dos workflows cita un comando que no exista
  for (const name of ['cruzar-evaluaciones', 'revisar-hallazgos']) {
    expect(
      fs.existsSync(path.join(root, '.claude', 'commands', `${name}.md`)),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, '.agent', 'workflows', `${name}.md`)),
    ).toBe(true);
  }
});
