import { z } from 'zod';

export const categorySchema = z.object({
  nombre: z.string(),
  peso: z.number().min(0).max(1),
  estrellas_min: z.number().optional(),
  contexto: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
});

export const interestsSchema = z.object({
  version: z.number().default(1),
  umbral_score: z.number().default(7),
  enrich_max: z.number().default(80),
  ventana_dias: z.number().default(14),
  idioma_informe: z.string().default('es'),
  reglas_globales: z
    .object({
      estrellas_min: z.number().default(50),
      ultimo_commit_max_dias: z.number().default(90),
      licencias_ok: z.array(z.string()).default([]),
      excluir_forks_sin_cambios: z.boolean().default(true),
      excluir_archivados: z.boolean().default(true),
    })
    .default({}),
  categorias: z.record(categorySchema).default({}),
  excluir: z.array(z.string()).default([]),
  proyectos: z
    .array(z.any())
    .transform((arr) =>
      arr.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))),
    )
    .default([]),
});

export type Interests = z.infer<typeof interestsSchema>;
export type Category = z.infer<typeof categorySchema>;

export const scoringSchema = z.object({
  candidateId: z.string(),
  week: z.string(),
  agent: z.enum(['antigravity', 'claude-code', 'human']),
  score: z.number().min(1).max(10),
  categoria: z.string(),
  proyectosAfectados: z.array(z.string()),
  porQue: z.string(),
  comoIntegrar: z.string(),
  riesgos: z.array(z.string()),
  usoBrowser: z.boolean(),
});

export type Scoring = z.infer<typeof scoringSchema>;
