import { z } from 'zod';

export const interestsSchema = z.object({
  categorias: z.record(z.number()).default({}), // Category name to weight
  topics: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  proyectos: z.array(z.string()).default([]),
  exclusiones: z.array(z.string()).default([]),
  reglas: z.object({
    minStars: z.number().default(0),
    maxAgeDays: z.number().default(365),
    requireLicense: z.boolean().default(true)
  }).default({})
});

export type Interests = z.infer<typeof interestsSchema>;

export const scoringSchema = z.object({
  candidateId: z.string(),
  week: z.string(),
  agent: z.enum(['antigravity', 'claude-code']),
  score: z.number().min(1).max(10),
  categoria: z.string(),
  proyectosAfectados: z.array(z.string()),
  porQue: z.string(),
  comoIntegrar: z.string(),
  riesgos: z.array(z.string()),
  usoBrowser: z.boolean()
});

export type Scoring = z.infer<typeof scoringSchema>;
