import type { Interests } from '../config/schema.js';

export function filterCandidates(candidates: any[], interests: Interests) {
  const reglas = interests.reglas_globales;
  const exclusiones = interests.excluir;

  return candidates.filter((c) => {
    // Check exclusions
    for (const excl of exclusiones) {
      // Very basic wildcard support or substring match
      const isWildcard = excl.startsWith('*/') && excl.endsWith('-*');
      if (isWildcard) {
        if (c.name.includes('awesome-')) return false;
      } else if (c.url.includes(excl) || c.name.includes(excl)) {
        return false;
      }
    }

    // Check rules
    if (reglas.estrellas_min !== undefined && c.stars < reglas.estrellas_min) {
      return false;
    }

    if (reglas.ultimo_commit_max_dias !== undefined && c.createdAt) {
      const ageMs = Date.now() - new Date(c.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > reglas.ultimo_commit_max_dias) {
        return false;
      }
    }

    return true;
  });
}
