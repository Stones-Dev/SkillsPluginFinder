// Datos reales para los tests (no forma parte de la API): las notas del vault, los
// resultados de búsqueda grabados de GitHub y el enrich real de alsk1992/CloddsBot.
import fs from 'node:fs';
import path from 'node:path';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import {
  applyEnrichment,
  cleanReadme,
  lifecycleScripts,
} from '../enrich/github.js';
import { type Candidate, normalizeGithubRepo } from '../normalize/index.js';
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
