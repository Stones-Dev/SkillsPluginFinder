import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { GithubRepo } from '../collectors/github.js';
import { parseInterestsYaml } from '../config/interests.js';
import type { CatalogEntry, Interests } from '../config/schema.js';
import { type Candidate, normalizeGithubRepo } from '../normalize/index.js';
import { parseCatalog } from '../vault/catalogo.js';
import { extractYamlBlock } from '../vault/markdown.js';
import { filterCandidates, matchesExclusion } from './index.js';

const fixtures = path.resolve(import.meta.dirname, '../../tests/fixtures');
const read = (name: string) =>
  fs.readFileSync(path.join(fixtures, name), 'utf8').replace(/\r\n/g, '\n');
const items = JSON.parse(read('github-search/response.json'))
  .items as GithubRepo[];
const interests = parseInterestsYaml(
  extractYamlBlock(read('vault/Intereses.md')).body,
  'Intereses.md',
);
const catalog = parseCatalog(read('vault/Catalogo.md'));

const NOW = new Date('2026-09-30T12:00:00Z');
const fromClaudeSkills = [
  {
    categoria: 'claude-skills',
    tipo: 'keyword' as const,
    query: 'claude code skill',
  },
];
const normalize = (repo: GithubRepo) =>
  normalizeGithubRepo(
    { repo, origins: fromClaudeSkills },
    { interests, now: NOW },
  );
const real = (fullName: string) => {
  const found = items.find((i) => i.full_name === fullName);
  if (!found) throw new Error(`${fullName} no está en el fixture`);
  return normalize(found);
};
const only = (
  candidate: Candidate,
  rules: Interests,
  entries: CatalogEntry[],
  now: Date,
) => filterCandidates([candidate], rules, entries, now);

test('30 repos reales con las reglas y el catálogo reales: 16 pasan y 14 se descartan con su motivo', () => {
  const candidates = items.map(normalize);
  const { kept, descartados } = filterCandidates(
    candidates,
    interests,
    catalog,
    NOW,
  );

  expect(kept.map((c) => c.name).sort()).toEqual(
    [
      'Donchitos/Claude-Code-Game-Studios',
      'Jeffallan/claude-skills',
      'Nutlope/hallmark',
      'SimoneAvogadro/android-reverse-engineering-skill',
      'alirezarezvani/claude-skills',
      'coreyhaines31/marketingskills',
      'czlonkowski/n8n-skills',
      'daymade/claude-code-skills',
      'diet103/claude-code-infrastructure-showcase',
      'krusemediallc/arcads-claude-code',
      'skills-directory/skill-codex',
      'tradermonty/claude-trading-skills',
      'virgiliojr94/book-to-skill',
      'wanshuiyin/Auto-claude-code-research-in-sleep',
      'zebbern/claude-code-guide',
      'zhaoxuya520/reverse-skill',
    ].sort(),
  );

  const byRule: Record<string, string[]> = {};
  for (const d of descartados) {
    byRule[d.regla] = [...(byRule[d.regla] ?? []), d.candidate.name];
  }
  expect(
    Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, v.length])),
  ).toEqual({
    'excluido-intereses': 4, // */awesome-*
    inactivo: 7,
    licencia: 3,
  });
  expect(byRule['excluido-intereses'].sort()).toEqual([
    'VoltAgent/awesome-agent-skills',
    'hesreallyhim/awesome-claude-code',
    'rohitg00/awesome-claude-code-toolkit',
    'travisvn/awesome-claude-skills',
  ]);
  expect(kept.length + descartados.length).toBe(30);
  for (const d of descartados) expect(d.motivo.length).toBeGreaterThan(0);
});

test('los motivos de descarte son legibles y concretos', () => {
  const motivo = (name: string) =>
    filterCandidates([real(name)], interests, catalog, NOW).descartados[0]
      ?.motivo;

  expect(motivo('hesreallyhim/awesome-claude-code')).toBe(
    'excluido en Intereses (`*/awesome-*`)',
  );
  expect(motivo('Imbad0202/academic-research-skills')).toBe(
    'licencia: NOASSERTION (no reconocida)',
  );
  expect(motivo('FlorianBruniaux/claude-code-ultimate-guide')).toBe(
    'licencia: CC-BY-SA-4.0 (fuera de licencias_ok)',
  );
  expect(motivo('ChrisWiles/claude-code-showcase')).toBe(
    'último commit hace 266 días (máximo 90)',
  );
});

test('un repo real sin licencia se descarta por licencia cuando está activo', () => {
  // multica-ai/andrej-karpathy-skills: sin licencia, último push el 2026-04-20.
  const candidate = real('multica-ai/andrej-karpathy-skills');
  const aprilNow = new Date('2026-05-01T00:00:00Z');

  expect(
    only(candidate, interests, catalog, aprilNow).descartados[0],
  ).toMatchObject({ regla: 'licencia', motivo: 'licencia: ninguna' });
  // en septiembre ya lleva 163 días inactivo: gana la regla anterior
  expect(only(candidate, interests, catalog, NOW).descartados[0].regla).toBe(
    'inactivo',
  );
});

test('lo adoptado o descartado en el catálogo se excluye; probado y candidato no', () => {
  const candidate = real('daymade/claude-code-skills');
  const entry = (estado: CatalogEntry['estado']): CatalogEntry => ({
    nombre: 'daymade/claude-code-skills',
    tipo: 'plugin',
    categoria: 'claude-skills',
    estado,
    semana: '2026-W40',
    score: 8,
    nota: '',
    enlace: 'https://github.com/daymade/claude-code-skills',
    repo: 'daymade/claude-code-skills',
  });

  for (const estado of ['adoptado', 'descartado'] as const) {
    expect(
      only(candidate, interests, [entry(estado)], NOW).descartados[0],
    ).toMatchObject({
      regla: 'excluido-catalogo',
      motivo: `ya en el catálogo como ${estado} (daymade/claude-code-skills)`,
    });
  }
  for (const estado of ['probado', 'candidato'] as const) {
    expect(only(candidate, interests, [entry(estado)], NOW).kept).toHaveLength(
      1,
    );
  }
});

test('matchesExclusion: glob sobre owner/repo, sin subcadenas', () => {
  expect(matchesExclusion('*/awesome-*', 'x/awesome-mcp')).toBe(true);
  expect(matchesExclusion('*/awesome-*', 'x/not-awesome-mcp')).toBe(false);
  expect(matchesExclusion('*/awesome-*', 'AWESOME/awesome-thing')).toBe(true);
  expect(matchesExclusion('obra/superpowers', 'Obra/SuperPowers')).toBe(true);
  expect(matchesExclusion('obra/superpowers', 'obra/superpowers-lab')).toBe(
    false,
  );
  // sin "/" se compara con el nombre del repo, no con subcadenas
  expect(matchesExclusion('bad', 'owner/bad')).toBe(true);
  expect(matchesExclusion('bad', 'owner/badger')).toBe(false);
  expect(matchesExclusion('bad', 'bad/other')).toBe(false);
  // los metacaracteres de regex se toman literalmente
  expect(matchesExclusion('a.b/c', 'aXb/c')).toBe(false);
});

test('estrellas_min de la categoría sugerida sustituye a la global', () => {
  const base = real('Jeffallan/claude-skills');
  const withStars = (stars: number, categoria: string): Candidate => ({
    ...base,
    stars,
    categoriaSugerida: categoria,
  });

  // claude-skills: mínimo 20 (propio); rust: sin propio => global 50
  expect(
    only(withStars(25, 'claude-skills'), interests, [], NOW).kept,
  ).toHaveLength(1);
  expect(
    only(withStars(25, 'rust'), interests, [], NOW).descartados[0],
  ).toMatchObject({
    regla: 'estrellas',
    motivo: '25 estrellas < 50 (mínimo de rust)',
  });
  expect(
    only(withStars(19, 'claude-skills'), interests, [], NOW).descartados[0]
      .motivo,
  ).toBe('19 estrellas < 20 (mínimo de claude-skills)');
});

test('archivados y forks se excluyen según las reglas globales', () => {
  const base = real('Jeffallan/claude-skills');
  expect(
    only({ ...base, archived: true }, interests, [], NOW).descartados[0].regla,
  ).toBe('archivado');
  expect(
    only({ ...base, fork: true }, interests, [], NOW).descartados[0].regla,
  ).toBe('fork');

  const lenient: Interests = {
    ...interests,
    reglas_globales: {
      ...interests.reglas_globales,
      excluir_archivados: false,
      excluir_forks_sin_cambios: false,
    },
  };
  expect(
    only({ ...base, archived: true, fork: true }, lenient, [], NOW).kept,
  ).toHaveLength(1);
});

test('la lista blanca de licencias es insensible a mayúsculas y una lista vacía la desactiva', () => {
  const base = real('Jeffallan/claude-skills');
  expect(
    only({ ...base, license: 'mit' }, interests, [], NOW).kept,
  ).toHaveLength(1);
  expect(
    only({ ...base, license: 'GPL-3.0' }, interests, [], NOW).descartados[0]
      .motivo,
  ).toBe('licencia: GPL-3.0 (fuera de licencias_ok)');

  const open: Interests = {
    ...interests,
    reglas_globales: { ...interests.reglas_globales, licencias_ok: [] },
  };
  expect(
    only({ ...base, license: undefined }, open, [], NOW).kept,
  ).toHaveLength(1);
});
