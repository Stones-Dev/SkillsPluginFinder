import { Interests } from '../config/schema.js';

export function filterCandidates(candidates: any[], interests: Interests) {
  const { reglas, exclusiones, keywords } = interests;
  
  return candidates.filter(c => {
    // Check exclusions (if URL or name includes any exclusion)
    for (const excl of exclusiones) {
      if (c.url.includes(excl) || c.name.includes(excl)) {
        return false;
      }
    }
    
    // Check rules
    if (reglas.minStars !== undefined && c.stars < reglas.minStars) {
      return false;
    }
    
    if (reglas.maxAgeDays !== undefined && c.createdAt) {
      const ageMs = Date.now() - new Date(c.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > reglas.maxAgeDays) {
        return false;
      }
    }
    
    // Optional: filter by keywords if needed (but usually keywords are for search, not for strict filtering)
    // For now, let's keep it simple.

    return true;
  });
}
