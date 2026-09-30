// Datos reales para los tests (no forma parte de la API): las notas del vault, los
// resultados de búsqueda grabados de GitHub y el enrich real de alsk1992/CloddsBot.
import fs from 'node:fs';
import path from 'node:path';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import type { Interests, Scoring } from '../config/schema.js';
import {
  applyEnrichment,
  cleanReadme,
  lifecycleScripts,
} from '../enrich/github.js';
import { filterCandidates } from '../filter/index.js';
import { type Candidate, normalizeGithubRepo } from '../normalize/index.js';
import type { CandidatesFile } from '../pipeline/candidates-file.js';
import { selectForEnrichment } from '../pipeline/quota.js';
import { parseCatalog } from '../vault/catalogo.js';
import { extractYamlBlock } from '../vault/markdown.js';

export const fixtures = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures',
);

export const readFixture = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8').replace(/\r\n/g, '\n');

export const NOW = new Date('2026-09-30T12:00:00Z');

export const interestsYaml = extractYamlBlock(
  readFixture('vault/Intereses.md'),
).body;
export const interests = parseInterestsYaml(interestsYaml, 'Intereses.md');
export const catalog = parseCatalog(readFixture('vault/Catalogo.md'));

const search = (name: string) =>
  JSON.parse(readFixture(`github-search/${name}`)).items as GithubRepo[];

/** Los 30 resultados reales de la búsqueda `claude code skill`, normalizados. */
export function realCandidates(categoria = 'claude-skills'): Candidate[] {
  return search('response.json').map((repo) =>
    normalizeGithubRepo(
      {
        repo,
        origins: [{ categoria, tipo: 'keyword', query: 'claude code skill' }],
      },
      { interests, now: NOW },
    ),
  );
}

/** alsk1992/CloddsBot con el enrich real grabado (README limpio, 4 contribuidores, postinstall). */
export function cloddsBot(): Candidate {
  const repo = search('topic-solana.json').find(
    (r) => r.full_name === 'alsk1992/CloddsBot',
  );
  if (!repo) throw new Error('CloddsBot no está en el fixture');
  const base = normalizeGithubRepo(
    {
      repo,
      origins: [{ categoria: 'solana', tipo: 'topic', query: 'solana' }],
    },
    { interests, now: NOW },
  );
  return applyEnrichment(base, {
    readmeExcerpt: cleanReadme(
      readFixture('github-enrich/alsk1992__CloddsBot.readme.md'),
    ),
    contributors: 4,
    singleMaintainer: false,
    lifecycleScripts: lifecycleScripts(
      JSON.parse(readFixture('github-enrich/alsk1992__CloddsBot.package.json')),
    ),
    notes: [],
  });
}

/**
 * Las reglas de la primera versión de Intereses, sin `estrellas_max` y con
 * `licencia_no_reconocida: descartar`. La semana de prueba del informe y de la
 * publicación se construye con ellas para que esos tests no se muevan cada vez
 * que se calibra el filtro; las reglas nuevas se prueban en `filter` y `quota`.
 */
export const weekInterests: Interests = {
  ...interests,
  reglas_globales: {
    ...interests.reglas_globales,
    estrellas_max: undefined,
    licencia_no_reconocida: 'descartar',
  },
};

/**
 * Una semana realista: los 30 repos reales pasan por el filtro y el tope reales
 * (enrich_max = 12) y se les añade CloddsBot. Los descartados y diferidos llevan
 * los motivos que produce el pipeline, no textos inventados.
 */
export function realWeekFile(): CandidatesFile {
  const { kept, descartados } = filterCandidates(
    realCandidates(),
    weekInterests,
    catalog,
    NOW,
  );
  const { selected, deferred } = selectForEnrichment(
    kept,
    { ...weekInterests, enrich_max: 12 },
    NOW,
  );
  return {
    week: '2026-W40',
    generatedAt: NOW.toISOString(),
    runs: [
      {
        at: NOW.toISOString(),
        trigger: 'manual',
        stats: {
          queries: 1,
          requests: 1,
          cacheHits: 0,
          rawItems: 30,
          uniqueRepos: 30,
          afterDedupe: 30,
          afterRules: kept.length,
          selected: selected.length,
          deferred: deferred.length,
          enriched: selected.length,
        },
        errorsBySource: [],
      },
    ],
    candidates: [...selected, cloddsBot()],
    descartados: descartados.map((d) => ({
      id: d.candidate.id,
      name: d.candidate.name,
      url: d.candidate.url,
      regla: d.regla,
      motivo: d.motivo,
    })),
    diferidos: deferred,
  };
}

export const scoreFor = (
  c: Candidate,
  over: Partial<Scoring> = {},
  week = '2026-W40',
): Scoring => ({
  candidateId: c.id,
  week,
  agent: 'claude-code',
  score: 5,
  categoria: 'claude-skills',
  proyectosAfectados: [],
  porQue: 'Razón concreta de por qué encaja o no con los proyectos.',
  comoIntegrar: 'Probarlo en una rama aparte.',
  riesgos: [],
  usoBrowser: false,
  ...over,
});

const SCORES = [9, 8, 7, 7, 6, 5, 5, 4, 3, 3, 2, 2, 8];

/** 13 scorings para `realWeekFile`: 5 llegan al umbral (9, 8, 7, 7 y CloddsBot con 8). */
export function realScorings(file: CandidatesFile): Scoring[] {
  return file.candidates.map((c, i) =>
    scoreFor(c, {
      score: SCORES[i],
      categoria:
        c.name === 'alsk1992/CloddsBot'
          ? 'solana'
          : i === 2 || i === 3
            ? 'agent-skills'
            : 'claude-skills',
      proyectosAfectados:
        c.name === 'alsk1992/CloddsBot'
          ? ['SonarTrench']
          : i === 0
            ? ['Vault Obsidian', 'AgentJobFinder']
            : [],
      riesgos:
        c.name === 'alsk1992/CloddsBot'
          ? ['Promociona un token en el README', 'Ejecuta un postinstall']
          : [],
      usoBrowser: c.name === 'alsk1992/CloddsBot',
    }),
  );
}
