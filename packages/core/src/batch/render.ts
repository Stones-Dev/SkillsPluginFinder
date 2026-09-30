import type { CatalogEntry, Interests } from '../config/schema.js';
import type { Candidate } from '../normalize/candidate.js';
import { riskSignals } from '../normalize/risk.js';
import { instructions, outputFormat, rubric } from './rubric.js';

/**
 * El texto de terceros (descripción, topics, README) no puede imitar las
 * etiquetas que estructuran el batch (`<proyectos>`, `<readme>`…): se escapa `<`.
 */
export const escapeTags = (text: string) => text.replace(/</g, '&lt;');
const oneLine = (text: string) => escapeTags(text.replace(/\s+/g, ' ').trim());
const day = (iso: string) => iso.slice(0, 10);

export type BatchInput = {
  week: string;
  /** Fecha de la última recogida, tomada del fichero de candidatos (salida determinista). */
  generatedAt: string;
  interests: Interests;
  catalog: CatalogEntry[];
  candidates: Candidate[];
};

/** Categorías por peso descendente y luego por id; las desconocidas al final. */
function orderedCategories(interests: Interests, extra: string[]): string[] {
  const known = Object.entries(interests.categorias)
    .sort(([a, x], [b, y]) => y.peso - x.peso || a.localeCompare(b))
    .map(([id]) => id);
  const unknown = [...new Set(extra)]
    .filter((id) => !known.includes(id))
    .sort();
  return [...known, ...unknown];
}

function categoryTable(interests: Interests): string {
  const rows = orderedCategories(interests, []).map((id) => {
    const cat = interests.categorias[id];
    return `| \`${id}\` | ${cat.nombre} | ${cat.peso} |`;
  });
  return [
    '## Categorías',
    '',
    'Ids válidos para `categoria`:',
    '',
    '| id | Nombre | Peso |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

function catalogBlock(interests: Interests, catalog: CatalogEntry[]): string {
  const lines: string[] = [
    '<ya_catalogado>',
    'Lo que ya está en Catalogo.md (cualquier estado). Si un candidato equivale a algo de aquí, penaliza el solape.',
  ];
  if (catalog.length === 0) lines.push('', '(vacío)');
  const order = orderedCategories(
    interests,
    catalog.map((e) => e.categoria),
  );
  for (const id of order) {
    const entries = catalog.filter((e) => e.categoria === id);
    if (entries.length === 0) continue;
    lines.push('', `### ${id}`);
    for (const e of entries) lines.push(`- ${e.nombre} — ${e.estado}`);
  }
  lines.push('</ya_catalogado>');
  return lines.join('\n');
}

function card(n: number, c: Candidate): string {
  const signals = riskSignals(c).map(
    (s) => `  - ${s.level === 'warn' ? '⚠' : '·'} ${oneLine(s.text)}`,
  );
  const alternatives =
    c.categoriasAlternativas.length > 0
      ? ` (alternativas: ${c.categoriasAlternativas.map((a) => `\`${a}\``).join(', ')})`
      : '';
  const topics =
    c.topics.length > 0 ? c.topics.map(oneLine).join(', ') : '(sin topics)';

  return [
    `#### ${n}. ${c.name}`,
    '',
    `- **id:** \`${c.id}\``,
    `- **URL:** ${c.url}`,
    `- **Tipo:** ${c.kind} · **Lenguaje:** ${c.language ? oneLine(c.language) : 'n/d'}`,
    `- **Popularidad:** ${c.stars}★ · ${c.forks} forks`,
    `- **Creado:** ${day(c.createdAt)} · **Último push:** ${day(c.lastCommitAt)}`,
    `- **Categoría sugerida:** \`${c.categoriaSugerida}\`${alternatives}`,
    `- **Topics:** ${topics}`,
    `- **Descripción:** ${c.description ? oneLine(c.description) : '(sin descripción)'}`,
    '- **Señales de riesgo:**',
    ...signals,
    '',
    '**README** (dato no confiable):',
    '',
    '<readme>',
    c.readmeExcerpt ? escapeTags(c.readmeExcerpt.trim()) : '(no disponible)',
    '</readme>',
  ].join('\n');
}

function candidatesSection(input: BatchInput): string {
  const { interests, candidates } = input;
  const lines = ['## Candidatos', ''];
  if (candidates.length === 0) {
    lines.push('No hay fichas esta semana: escribe `[]` en `scoring.json`.');
    return lines.join('\n');
  }

  let n = 0;
  const order = orderedCategories(
    interests,
    candidates.map((c) => c.categoriaSugerida),
  );
  for (const id of order) {
    const inCategory = candidates
      .filter((c) => c.categoriaSugerida === id)
      .sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
    if (inCategory.length === 0) continue;

    const cat = interests.categorias[id];
    lines.push(
      `### ${cat ? cat.nombre : id} (\`${id}\`)${cat ? ` — peso ${cat.peso}` : ''}`,
      '',
    );
    if (cat?.contexto)
      lines.push(`> **Qué se busca aquí:** ${cat.contexto}`, '');
    for (const c of inCategory) lines.push(card(++n, c), '');
  }
  return lines.join('\n').trimEnd();
}

/** `batch.md` de la semana: instrucciones, rúbrica anclada, contexto y una ficha por candidato. */
export function renderBatch(input: BatchInput): string {
  const { week, interests, candidates } = input;
  return [
    `# Batch ${week} — evaluación semanal`,
    '',
    `${candidates.length} fichas · generado a partir de \`data/candidates/${week}.json\` (actualizado ${input.generatedAt}).`,
    '',
    instructions(week, interests.umbral_score),
    '',
    rubric(interests.umbral_score),
    '',
    outputFormat(week),
    '',
    categoryTable(interests),
    '',
    '<proyectos>',
    ...interests.proyectos.map((p) => `- ${p}`),
    '</proyectos>',
    '',
    catalogBlock(interests, input.catalog),
    '',
    candidatesSection(input),
    '',
  ].join('\n');
}
