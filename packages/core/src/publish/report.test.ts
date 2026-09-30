import matter from 'gray-matter';
import { expect, test } from 'vitest';
import { filterCandidates } from '../filter/index.js';
import type { CandidatesFile } from '../pipeline/candidates-file.js';
import {
  NOW,
  catalog,
  interests,
  realCandidates,
  realScorings,
  realWeekFile,
  scoreFor,
} from '../testing/real-data.js';
import { cell, renderReport } from './report.js';

const file = realWeekFile();
const scorings = realScorings(file);
const render = (over: Partial<Parameters<typeof renderReport>[0]> = {}) =>
  renderReport({
    week: '2026-W40',
    now: NOW,
    interests,
    file,
    scorings,
    ...over,
  });
const md = render();
const day = (value: unknown) =>
  new Date(value as Date).toISOString().slice(0, 10);

const headings = (text: string, level: string) =>
  [...text.matchAll(new RegExp(`^${level} (.*)$`, 'gm'))].map((m) => m[1]);

test('frontmatter del vault: type log, status draft, revisado false, semana y agente', () => {
  const { data } = matter(md);

  expect(data).toMatchObject({
    aliases: ['Informe 2026-W40'],
    type: 'log',
    status: 'draft',
    tags: ['ia', 'claude-code'],
    related: ['[[SkillsPluginFinder]]', '[[Catalogo]]', '[[Intereses]]'],
    project_id: 'skillspluginfinder',
    semana: '2026-W40',
    agente: 'claude-code',
    revisado: false,
  });
  expect(day(data.created)).toBe('2026-09-30');
  expect(day(data.updated)).toBe('2026-09-30');
  // solo valores escalares, listas planas y fechas (AGENTS §4)
  for (const value of Object.values(data)) {
    expect(
      typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date),
    ).toBe(false);
  }
});

test('secciones por categoría por peso, con solo lo que llega al umbral', () => {
  expect(headings(md, '##')).toEqual([
    'Skills y plugins para Claude y Claude Code (2)',
    'Agent skills (formato abierto, multiagente) (2)',
    'Blockchain Solana (1)',
    'Errores por fuente',
    'Trazabilidad',
  ]);
  expect(md).toContain(
    '**5 hallazgos** con score ≥ 7 de **13** evaluados. Agente: claude-code.',
  );
});

test('los hallazgos de cada categoría van por score descendente', () => {
  expect(headings(md, '###').map((h) => h.split(' · ')[0])).toEqual([
    '9',
    '8',
    '7',
    '7',
    '8',
  ]);
});

test('la ficha de un hallazgo lleva por qué, cómo integrar, riesgos, señales y enlaces', () => {
  const start = md.indexOf('### 8 · [alsk1992/CloddsBot]');
  const ficha = md.slice(
    start,
    md.indexOf('\n## ', start) === -1 ? undefined : md.indexOf('\n## ', start),
  );

  expect(ficha).toContain(
    '### 8 · [alsk1992/CloddsBot](https://github.com/alsk1992/CloddsBot)',
  );
  expect(ficha).toContain('**Proyectos:** SonarTrench');
  expect(ficha).toContain('- **Por qué:** Razón concreta');
  expect(ficha).toContain('- **Cómo integrar:** Probarlo en una rama aparte.');
  expect(ficha).toContain(
    '- **Riesgos:**\n  - Promociona un token en el README\n  - Ejecuta un postinstall',
  );
  expect(ficha).toContain(
    '⚠ package.json ejecuta scripts al instalar: postinstall',
  );
  expect(ficha).toContain('· 4 contribuidores');
  expect(ficha).toContain(
    '- **Enlaces:** [Repositorio](https://github.com/alsk1992/CloddsBot) · `github:alsk1992/cloddsbot` · el evaluador consultó la web',
  );
});

test('las señales del pipeline salen siempre, también cuando el evaluador no vio riesgos', () => {
  const first = md.slice(md.indexOf('### 9 ·'));
  expect(first).toContain(
    '- **Riesgos:**\n  - Ninguno señalado por el evaluador',
  );
  expect(first).toContain('- **Señales del pipeline:** ');
  expect(first).toContain('**Proyectos:** Vault Obsidian, AgentJobFinder');
});

test('lo evaluado por debajo del umbral va en un callout plegado con tabla', () => {
  expect(md).toContain('> [!note]- Evaluados por debajo del umbral de 7 (8)');
  const rows = md.split('\n').filter((l) => /^> \| \d \| \[/.test(l));
  expect(rows).toHaveLength(8);
  expect(rows[0]).toMatch(
    /^> \| 6 \| \[.+\]\(https:\/\/github\.com\/.+\) \| claude-skills \| Razón concreta/,
  );
});

test('los descartados por reglas se agrupan por regla, con los motivos reales', () => {
  expect(md).toContain('> [!note]- Descartados por reglas (14)');
  expect(md).toContain('> **Excluidos en Intereses (4)**');
  expect(md).toContain('> **Inactivos (7)**');
  expect(md).toContain('> **Licencia (3)**');
  expect(md).toContain(
    '> - [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — excluido en Intereses (`*/awesome-*`)',
  );
  expect(md).toContain('licencia: NOASSERTION (no reconocida)');
});

test('el grupo de estrellas recoge tanto el mínimo como el techo, y se llama «fuera de rango»', () => {
  // Descartes reales del filtro con las reglas de hoy: los 30 repos reales pasan por
  // él (8 por encima de 20.000★) y uno de ellos con solo 12 estrellas cae por el mínimo.
  const candidates = realCandidates();
  const { descartados } = filterCandidates(
    [...candidates, { ...candidates[5], id: 'github:x/pocas', stars: 12 }],
    interests,
    catalog,
    NOW,
  );
  const stars = descartados.filter((d) => d.regla === 'estrellas');
  expect(stars).toHaveLength(9);

  const withStars: CandidatesFile = {
    ...file,
    descartados: stars.map((d) => ({
      id: d.candidate.id,
      name: d.candidate.name,
      url: d.candidate.url,
      regla: d.regla,
      motivo: d.motivo,
    })),
  };
  const out = render({ file: withStars });

  expect(out).toContain('> **Estrellas fuera de rango (9)**');
  expect(out).not.toContain('Pocas estrellas');
  expect(out).toContain(
    '— 215987 estrellas > 20000 (máximo de las reglas globales)',
  );
  expect(out).toMatch(/— 12 estrellas < \d+ \(mínimo de /);
});

test('los diferidos por el tope se listan aparte y explican que pueden volver', () => {
  expect(md).toContain('> [!note]- Diferidos por el tope de evaluación (4)');
  expect(md).toContain('No se marcan como vistos: pueden volver otra semana.');
});

test('todos los callouts están bien formados: sin líneas sin ">" hasta la línea en blanco que los cierra', () => {
  const lines = md.split('\n');
  let inCallout = false;
  let callouts = 0;
  for (const line of lines) {
    if (line.startsWith('> [!')) {
      inCallout = true;
      callouts++;
    } else if (inCallout) {
      if (line === '') inCallout = false;
      else
        expect(line.startsWith('>'), `línea fuera del callout: ${line}`).toBe(
          true,
        );
    }
  }
  expect(callouts).toBe(3);
});

test('las cifras por etapa suman las ejecuciones de la semana', () => {
  expect(md).toContain('| Repos únicos encontrados | 30 |');
  expect(md).toContain('| Descartados por reglas | 14 |');
  expect(md).toContain('| Diferidos por el tope `enrich_max` | 4 |');
  expect(md).toContain('| Enriquecidos y evaluados | 13 |');
  expect(md).toContain('| **Publicados (≥ 7)** | **5** |');

  const twoRuns: CandidatesFile = {
    ...file,
    runs: [...file.runs, ...file.runs],
  };
  const merged = render({ file: twoRuns });
  expect(merged).toContain('| Repos únicos encontrados | 60 |');
  expect(merged).toContain('Recogida: 2 ejecuciones de `spf collect`');
});

test('los errores por fuente se listan sin repetir y, si no hay, se dice', () => {
  expect(md).toContain('## Errores por fuente\n\nNinguno.');

  const failing: CandidatesFile = {
    ...file,
    runs: [
      {
        ...file.runs[0],
        errorsBySource: [
          {
            source: 'github-search',
            query: 'topic:x',
            message: 'Validation Failed',
          },
        ],
      },
      {
        ...file.runs[0],
        errorsBySource: [
          {
            source: 'github-search',
            query: 'topic:x',
            message: 'Validation Failed',
          },
        ],
      },
    ],
  };
  const out = render({ file: failing });
  expect(out).toContain('- github-search · `topic:x`: Validation Failed');
  expect(out.split('Validation Failed')).toHaveLength(2);
});

test('una semana sin nada por encima del umbral lo dice, y sigue mostrando lo evaluado', () => {
  const low = scorings.map((s) => ({ ...s, score: 4 }));
  const out = render({ scorings: low });

  expect(out).toContain(
    'Esta semana nada relevante: ninguna de las 13 fichas evaluadas llegó al umbral de 7.',
  );
  expect(headings(out, '###')).toEqual([]);
  expect(out).toContain('> [!note]- Evaluados por debajo del umbral de 7 (13)');
  expect(out).toContain('| **Publicados (≥ 7)** | **0** |');
});

test('una semana totalmente vacía es un informe válido', () => {
  const empty: CandidatesFile = {
    ...file,
    runs: [],
    candidates: [],
    descartados: [],
    diferidos: [],
  };
  const out = render({ file: empty, scorings: [] });

  expect(matter(out).data).toMatchObject({
    agente: 'ninguno',
    revisado: false,
  });
  expect(out).toContain('Esta semana nada relevante');
  expect(out).not.toContain('[!note]-');
});

test('con evaluadores distintos el agente es "mixto"', () => {
  const mixed = scorings.map((s, i) =>
    i === 0 ? { ...s, agent: 'antigravity' as const } : s,
  );
  expect(matter(render({ scorings: mixed })).data.agente).toBe('mixto');
});

test('conserva el created de un informe anterior y actualiza updated', () => {
  const out = render({
    created: '2026-09-28',
    now: new Date('2026-10-02T09:00:00Z'),
  });
  const { data } = matter(out);
  expect(day(data.created)).toBe('2026-09-28');
  expect(day(data.updated)).toBe('2026-10-02');
});

test('el texto del evaluador cabe en una celda de tabla: sin saltos de línea y con | escapados', () => {
  expect(cell('a | b\nc')).toBe('a \\| b c');

  const tricky = scorings.map((s, i) =>
    i === 6 ? { ...s, porQue: 'Sirve para X | Y\ny para Z' } : s,
  );
  const out = render({ scorings: tricky });
  expect(out).toContain('Sirve para X \\| Y y para Z |');
});

test('la salida es determinista', () => {
  expect(render()).toBe(render());
  expect(render({ scorings: [...scorings].reverse() })).toBe(md);
  expect(scoreFor(file.candidates[0]).week).toBe('2026-W40');
});
