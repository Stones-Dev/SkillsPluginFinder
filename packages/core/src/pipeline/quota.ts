import type { Interests } from '../config/schema.js';
import type { Candidate } from '../normalize/candidate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_WEIGHT = 1e-6; // una categoría con peso 0 no se queda sin sitio por división por cero

/**
 * Reparte `total` plazas entre categorías de forma proporcional a su peso sin
 * pasarse de su demanda (`sizes`). Lo que una categoría no puede llenar se
 * redistribuye entre las demás; el resto entero va por mayor resto.
 * Invariante: la suma es `min(total, Σ sizes)`.
 */
export function allocateQuota(
  sizes: Record<string, number>,
  weights: Record<string, number>,
  total: number,
): Record<string, number> {
  const alloc: Record<string, number> = {};
  for (const key of Object.keys(sizes)) alloc[key] = 0;

  let remaining = Math.min(
    total,
    Object.values(sizes).reduce((sum, n) => sum + n, 0),
  );
  let active = Object.keys(sizes).filter((k) => sizes[k] > 0);
  const weight = (k: string) => Math.max(weights[k] ?? 0, MIN_WEIGHT);

  while (remaining > 0 && active.length > 0) {
    const sumWeights = active.reduce((sum, k) => sum + weight(k), 0);
    const saturated = active.filter(
      (k) => (remaining * weight(k)) / sumWeights >= sizes[k] - alloc[k],
    );

    if (saturated.length > 0) {
      for (const k of saturated) {
        remaining -= sizes[k] - alloc[k];
        alloc[k] = sizes[k];
      }
      active = active.filter((k) => !saturated.includes(k));
      continue;
    }

    const shares = active.map((k) => ({
      k,
      exact: (remaining * weight(k)) / sumWeights,
    }));
    let given = 0;
    for (const { k, exact } of shares) {
      alloc[k] += Math.floor(exact);
      given += Math.floor(exact);
    }
    shares.sort(
      (a, b) =>
        b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) ||
        weight(b.k) - weight(a.k) ||
        a.k.localeCompare(b.k),
    );
    for (let i = 0; i < remaining - given; i++) alloc[shares[i].k]++;
    remaining = 0;
  }
  return alloc;
}

export type Deferred = {
  id: string;
  name: string;
  url: string;
  categoria: string;
  stars: number;
  motivo: string;
};

/**
 * Tope `enrich_max` (cuota de API y de tiempo del evaluador): cada categoría
 * recibe plazas proporcionales a su `peso`; dentro de una categoría van primero
 * los creados dentro de la ventana y después los de más estrellas. Lo que no
 * cabe queda *diferido*: no se marca como visto y puede volver otra semana.
 */
export function selectForEnrichment(
  kept: Candidate[],
  interests: Interests,
  now: Date,
): { selected: Candidate[]; deferred: Deferred[] } {
  const windowStart = now.getTime() - interests.ventana_dias * DAY_MS;
  const byCategory = new Map<string, Candidate[]>();
  for (const c of kept) {
    byCategory.set(c.categoriaSugerida, [
      ...(byCategory.get(c.categoriaSugerida) ?? []),
      c,
    ]);
  }

  const sizes: Record<string, number> = {};
  const weights: Record<string, number> = {};
  for (const [id, list] of byCategory) {
    sizes[id] = list.length;
    weights[id] = interests.categorias[id]?.peso ?? 0;
  }
  const quota = allocateQuota(sizes, weights, interests.enrich_max);

  const inWindow = (c: Candidate) => Date.parse(c.createdAt) >= windowStart;
  const order = [...byCategory.keys()].sort(
    (a, b) => weights[b] - weights[a] || a.localeCompare(b),
  );

  const selected: Candidate[] = [];
  const deferred: Deferred[] = [];
  for (const id of order) {
    const ranked = [...(byCategory.get(id) ?? [])].sort(
      (a, b) =>
        Number(inWindow(b)) - Number(inWindow(a)) ||
        b.stars - a.stars ||
        a.name.localeCompare(b.name),
    );
    selected.push(...ranked.slice(0, quota[id]));
    for (const c of ranked.slice(quota[id])) {
      deferred.push({
        id: c.id,
        name: c.name,
        url: c.url,
        categoria: id,
        stars: c.stars,
        motivo: `tope enrich_max=${interests.enrich_max}: cuota de ${id} = ${quota[id]} de ${sizes[id]}`,
      });
    }
  }
  return { selected, deferred };
}
