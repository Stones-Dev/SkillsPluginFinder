import type { CatalogEntry, Interests } from '../config/schema.js';
import type { Candidate } from '../normalize/candidate.js';

/** Reglas duras (RF-4), en el orden en que se evalúan: gana la primera que salta. */
export const FILTER_RULES = [
  'excluido-intereses',
  'excluido-catalogo',
  'archivado',
  'fork',
  'estrellas',
  'inactivo',
  'licencia',
] as const;

export type FilterRule = (typeof FILTER_RULES)[number];
export type Discarded = {
  candidate: Candidate;
  regla: FilterRule;
  /** Legible, se muestra en "descartados por reglas" del informe. */
  motivo: string;
};
export type FilterResult = { kept: Candidate[]; descartados: Discarded[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Patrón de `excluir` sobre `owner/repo` (sin distinguir mayúsculas). `*` casa
 * con cualquier cosa salvo `/`. Un patrón sin `/` se compara con el nombre del
 * repo; nunca es una subcadena, así que `bad` no excluye `badger`.
 */
export function matchesExclusion(pattern: string, fullName: string): boolean {
  const p = pattern.trim().toLowerCase();
  const name = fullName.toLowerCase();
  const target = p.includes('/') ? name : (name.split('/')[1] ?? name);
  const regex = new RegExp(`^${p.split('*').map(escapeRegex).join('[^/]*')}$`);
  return regex.test(target);
}

/**
 * Filtra por reglas y devuelve qué se descarta y por qué. Las exclusiones vienen
 * de `interests.excluir` y de lo `adoptado`/`descartado` en el catálogo; el
 * resto son las `reglas_globales`, con la `estrellas_min` de la categoría
 * sugerida cuando la tiene.
 */
export function filterCandidates(
  candidates: Candidate[],
  interests: Interests,
  catalog: CatalogEntry[],
  now: Date = new Date(),
): FilterResult {
  const rules = interests.reglas_globales;
  const licensesOk = new Set(rules.licencias_ok.map((l) => l.toLowerCase()));
  const excluded = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    if (entry.repo && ['adoptado', 'descartado'].includes(entry.estado)) {
      excluded.set(entry.repo, entry);
    }
  }

  const evaluate = (c: Candidate): Omit<Discarded, 'candidate'> | null => {
    const pattern = interests.excluir.find((p) => matchesExclusion(p, c.name));
    if (pattern !== undefined) {
      return {
        regla: 'excluido-intereses',
        motivo: `excluido en Intereses (\`${pattern}\`)`,
      };
    }

    const entry = excluded.get(c.name.toLowerCase());
    if (entry) {
      return {
        regla: 'excluido-catalogo',
        motivo: `ya en el catálogo como ${entry.estado} (${entry.nombre})`,
      };
    }

    if (rules.excluir_archivados && c.archived) {
      return { regla: 'archivado', motivo: 'repositorio archivado' };
    }

    // La búsqueda no dice si un fork ha divergido: se excluyen todos.
    if (rules.excluir_forks_sin_cambios && c.fork) {
      return { regla: 'fork', motivo: 'fork (no se verifica si ha divergido)' };
    }

    const category = interests.categorias[c.categoriaSugerida];
    const minStars = category?.estrellas_min ?? rules.estrellas_min;
    if (c.stars < minStars) {
      return {
        regla: 'estrellas',
        motivo: `${c.stars} estrellas < ${minStars} (mínimo de ${category ? c.categoriaSugerida : 'las reglas globales'})`,
      };
    }

    const idleDays = Math.floor(
      (now.getTime() - Date.parse(c.lastCommitAt)) / DAY_MS,
    );
    if (idleDays > rules.ultimo_commit_max_dias) {
      return {
        regla: 'inactivo',
        motivo: `último commit hace ${idleDays} días (máximo ${rules.ultimo_commit_max_dias})`,
      };
    }

    if (licensesOk.size > 0) {
      const license = c.license;
      if (!license) {
        return { regla: 'licencia', motivo: 'licencia: ninguna' };
      }
      if (license.toUpperCase() === 'NOASSERTION') {
        return {
          regla: 'licencia',
          motivo: 'licencia: NOASSERTION (no reconocida)',
        };
      }
      if (!licensesOk.has(license.toLowerCase())) {
        return {
          regla: 'licencia',
          motivo: `licencia: ${license} (fuera de licencias_ok)`,
        };
      }
    }

    return null;
  };

  const kept: Candidate[] = [];
  const descartados: Discarded[] = [];
  for (const candidate of candidates) {
    const verdict = evaluate(candidate);
    if (verdict) descartados.push({ candidate, ...verdict });
    else kept.push(candidate);
  }
  return { kept, descartados };
}
