import type { Interests, Scoring } from '../config/schema.js';
import { type Cruce, type CruceItem, crossLine } from '../cross/cross.js';
import { FILTER_RULES, type FilterRule } from '../filter/index.js';
import type { Candidate } from '../normalize/candidate.js';
import { riskSignals } from '../normalize/risk.js';
import type { CandidatesFile } from '../pipeline/candidates-file.js';
import { madridDate } from '../pipeline/week.js';

export type ReportInput = {
  week: string;
  now: Date;
  interests: Interests;
  file: CandidatesFile;
  scorings: Scoring[];
  /** `created` de un informe anterior de la misma semana, si lo había. */
  created?: string;
  /** El cruce de las dos evaluaciones; los `scorings` ya llevan su score final. */
  cruce?: Cruce | null;
};

export type Finding = {
  scoring: Scoring;
  candidate: Candidate;
  cruce?: CruceItem;
};

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Celda de tabla Markdown: una línea y con los `|` escapados. */
export const cell = (text: string) => oneLine(text).replace(/\|/g, '\\|');

const RULE_LABEL: Record<FilterRule, string> = {
  'excluido-intereses': 'Excluidos en Intereses',
  'excluido-catalogo': 'Ya en el catálogo',
  archivado: 'Archivados',
  fork: 'Forks',
  // La regla cubre el mínimo y el techo de `estrellas_max`; cada línea dice cuál saltó.
  estrellas: 'Estrellas fuera de rango',
  inactivo: 'Inactivos',
  licencia: 'Licencia',
};

/** Callout plegable de Obsidian: todas las líneas, también las vacías, llevan `>`. */
function callout(title: string, body: string[]): string {
  return [
    `> [!note]- ${title}`,
    ...body.map((line) => (line === '' ? '>' : `> ${line}`)),
  ].join('\n');
}

const byScore = (a: Finding, b: Finding) =>
  b.scoring.score - a.scoring.score ||
  b.candidate.stars - a.candidate.stars ||
  a.candidate.name.localeCompare(b.candidate.name);

function frontmatter(input: ReportInput, agent: string): string {
  const today = madridDate(input.now);
  return [
    '---',
    'aliases:',
    `  - Informe ${input.week}`,
    'type: log',
    'status: draft',
    'tags:',
    '  - ia',
    '  - claude-code',
    `created: ${input.created ?? today}`,
    `updated: ${today}`,
    'related:',
    '  - "[[SkillsPluginFinder]]"',
    '  - "[[Catalogo]]"',
    '  - "[[Intereses]]"',
    'project_id: skillspluginfinder',
    `semana: ${input.week}`,
    `agente: ${agent}`,
    'revisado: false',
    '---',
  ].join('\n');
}

function stagesTable(input: ReportInput, published: number): string {
  const { file, scorings } = input;
  const sum = (key: 'uniqueRepos' | 'afterDedupe') =>
    file.runs.reduce((total, run) => total + run.stats[key], 0);
  const runs = file.runs.length;
  return [
    '| Etapa | Nº |',
    '|---|---|',
    `| Repos únicos encontrados | ${sum('uniqueRepos')} |`,
    `| Tras el dedupe (no vistos antes) | ${sum('afterDedupe')} |`,
    `| Descartados por reglas | ${file.descartados.length} |`,
    `| Diferidos por el tope \`enrich_max\` | ${file.diferidos.length} |`,
    `| Enriquecidos y evaluados | ${scorings.length} |`,
    `| **Publicados (≥ ${input.interests.umbral_score})** | **${published}** |`,
    '',
    `Recogida: ${runs} ${runs === 1 ? 'ejecución' : 'ejecuciones'} de \`spf collect\` (las cifras de las dos primeras filas suman todas).`,
  ].join('\n');
}

function findingCard(f: Finding): string {
  const { scoring: s, candidate: c } = f;
  const signals = riskSignals(c)
    .map((sig) => `${sig.level === 'warn' ? '⚠ ' : ''}${oneLine(sig.text)}`)
    .join(' · ');
  const risks =
    s.riesgos.length > 0
      ? s.riesgos.map((r) => `  - ${oneLine(r)}`)
      : ['  - Ninguno señalado por el evaluador'];

  const crossed = crossLine(f.cruce);

  return [
    `### ${s.score} · [${c.name}](${c.url})`,
    '',
    `${c.kind} · ${c.stars}★ · ${c.license ?? 'sin licencia'} · creado ${c.createdAt.slice(0, 10)}`,
    '',
    `**Proyectos:** ${s.proyectosAfectados.length > 0 ? s.proyectosAfectados.join(', ') : 'ninguno en concreto'}`,
    '',
    ...(crossed ? [crossed, ''] : []),
    `- **Por qué:** ${oneLine(s.porQue)}`,
    `- **Cómo integrar:** ${oneLine(s.comoIntegrar)}`,
    '- **Riesgos:**',
    ...risks,
    `- **Señales del pipeline:** ${signals}`,
    `- **Enlaces:** [Repositorio](${c.url}) · \`${c.id}\`${s.usoBrowser ? ' · el evaluador consultó la web' : ''}`,
  ].join('\n');
}

function underThreshold(items: Finding[], umbral: number): string {
  return callout(
    `Evaluados por debajo del umbral de ${umbral} (${items.length})`,
    [
      'Sirve para calibrar `Intereses.md`: si aquí hay cosas buenas, sube el peso de su categoría o afina las keywords.',
      '',
      '| Score | Repositorio | Categoría | Por qué |',
      '|---|---|---|---|',
      ...items.map(
        ({ scoring: s, candidate: c }) =>
          `| ${s.score} | [${c.name}](${c.url}) | ${s.categoria} | ${cell(s.porQue)} |`,
      ),
    ],
  );
}

function discardedByRules(file: CandidatesFile): string {
  const lines: string[] = [];
  for (const rule of FILTER_RULES) {
    const group = file.descartados.filter((d) => d.regla === rule);
    if (group.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`**${RULE_LABEL[rule]} (${group.length})**`, '');
    for (const d of group)
      lines.push(`- [${d.name}](${d.url}) — ${oneLine(d.motivo)}`);
  }
  return callout(`Descartados por reglas (${file.descartados.length})`, lines);
}

function deferredByCap(file: CandidatesFile): string {
  return callout(
    `Diferidos por el tope de evaluación (${file.diferidos.length})`,
    [
      'Pasaron las reglas pero no cupieron en `enrich_max`. No se marcan como vistos: pueden volver otra semana.',
      '',
      ...file.diferidos.map(
        (d) => `- [${d.name}](${d.url}) — ${d.categoria}, ${d.stars}★`,
      ),
    ],
  );
}

function errorsSection(file: CandidatesFile): string {
  const errors = file.runs.flatMap((run) => run.errorsBySource);
  const unique = [
    ...new Map(
      errors.map((e) => [`${e.source}|${e.query}|${e.message}`, e]),
    ).values(),
  ];
  return [
    '## Errores por fuente',
    '',
    ...(unique.length === 0
      ? ['Ninguno.']
      : unique.map(
          (e) =>
            `- ${e.source}${e.query ? ` · \`${oneLine(e.query)}\`` : ''}: ${oneLine(e.message)}`,
        )),
  ].join('\n');
}

/** Informe semanal en Markdown (RF-6). Determinista para una misma entrada. */
export function renderReport(input: ReportInput): string {
  const { week, interests, file, scorings } = input;
  const umbral = interests.umbral_score;
  const byId = new Map(file.candidates.map((c) => [c.id, c]));

  const crossById = new Map(
    (input.cruce?.items ?? []).map((i) => [i.candidateId, i]),
  );
  const findings: Finding[] = scorings.flatMap((scoring) => {
    const candidate = byId.get(scoring.candidateId);
    return candidate
      ? [{ scoring, candidate, cruce: crossById.get(scoring.candidateId) }]
      : [];
  });
  const published = findings
    .filter((f) => f.scoring.score >= umbral)
    .sort(byScore);
  const below = findings.filter((f) => f.scoring.score < umbral).sort(byScore);

  const agents = [...new Set(scorings.map((s) => s.agent))];
  const crossedBoth = (input.cruce?.fuentes.length ?? 0) > 1;
  const agent =
    agents.length === 0
      ? 'ninguno'
      : agents.length === 1 && !crossedBoth
        ? agents[0]
        : 'mixto';

  const sections: string[] = [
    frontmatter(input, agent),
    `# Informe ${week}`,
    published.length > 0
      ? `**${published.length} hallazgo${published.length === 1 ? '' : 's'}** con score ≥ ${umbral} de **${findings.length}** evaluados. Agente: ${agent}. Borrador pendiente de revisión (\`revisado: false\`).`
      : `Esta semana nada relevante: ninguna de las ${findings.length} fichas evaluadas llegó al umbral de ${umbral}. Agente: ${agent}. Borrador pendiente de revisión (\`revisado: false\`).`,
    stagesTable(input, published.length),
  ];

  const order = Object.entries(interests.categorias)
    .sort(([a, x], [b, y]) => y.peso - x.peso || a.localeCompare(b))
    .map(([id]) => id);
  const extra = [...new Set(published.map((f) => f.scoring.categoria))]
    .filter((id) => !order.includes(id))
    .sort();
  for (const id of [...order, ...extra]) {
    const inCategory = published.filter((f) => f.scoring.categoria === id);
    if (inCategory.length === 0) continue;
    sections.push(
      `## ${interests.categorias[id]?.nombre ?? id} (${inCategory.length})`,
      ...inCategory.map(findingCard),
    );
  }

  if (below.length > 0) sections.push(underThreshold(below, umbral));
  if (file.descartados.length > 0) sections.push(discardedByRules(file));
  if (file.diferidos.length > 0) sections.push(deferredByCap(file));
  sections.push(
    errorsSection(file),
    [
      '## Trazabilidad',
      '',
      `- Candidatos: \`data/candidates/${week}.json\``,
      `- Batch y scoring crudo del evaluador: \`data/batches/${week}/batch.md\` · \`scoring.json\``,
      ...(crossedBoth
        ? [
            `- Segunda evaluación (Antigravity) y cruce: \`data/batches/${week}/scoring-antigravity.json\` · \`cruce.json\` (score = media; disputa si difieren en 3 o más; confianza alta si los dos llegan a 7)`,
          ]
        : []),
    ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}
