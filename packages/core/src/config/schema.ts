import { z } from 'zod';

export const categorySchema = z
  .object({
    nombre: z.string().min(1),
    peso: z.number().min(0).max(1),
    estrellas_min: z.number().int().nonnegative().optional(),
    contexto: z.string().optional(),
    keywords: z.array(z.string().min(1)).default([]),
    topics: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const interestsSchema = z
  .object({
    version: z.number().int().default(1),
    umbral_score: z.number().min(1).max(10).default(7),
    enrich_max: z.number().int().positive().default(80),
    ventana_dias: z.number().int().positive().default(14),
    idioma_informe: z.string().default('es'),
    reglas_globales: z
      .object({
        estrellas_min: z.number().int().nonnegative().default(50),
        /** Techo: un repo que ya conoce todo el mundo no es un hallazgo. Sin valor, no hay techo. */
        estrellas_max: z.number().int().positive().optional(),
        ultimo_commit_max_dias: z.number().int().positive().default(90),
        licencias_ok: z.array(z.string()).default([]),
        /**
         * Qué hacer con `NOASSERTION` (GitHub no reconoce la licencia): `riesgo` lo deja
         * pasar con la señal «Licencia no reconocida»; `descartar` lo trata como fuera de
         * `licencias_ok`. «Sin licencia» se descarta siempre.
         */
        licencia_no_reconocida: z
          .enum(['descartar', 'riesgo'])
          .default('descartar'),
        excluir_forks_sin_cambios: z.boolean().default(true),
        excluir_archivados: z.boolean().default(true),
      })
      .strict()
      .refine(
        (r) =>
          r.estrellas_max === undefined || r.estrellas_max > r.estrellas_min,
        {
          message: 'estrellas_max debe ser mayor que estrellas_min',
          path: ['estrellas_max'],
        },
      )
      .default({}),
    categorias: z.record(categorySchema).default({}),
    excluir: z.array(z.string().min(1)).default([]),
    /**
     * Listas `awesome-*` que sigue el colector `awesome-list`: `owner/repo` de la
     * lista → id de la categoría a la que pertenecen sus novedades. Opcional: sin el
     * bloque, el colector no hace nada.
     */
    awesome_listas: z
      .record(
        z
          .string()
          .regex(
            /^[\w.-]+\/[\w.-]+$/,
            'se espera owner/repo, p. ej. sindresorhus/awesome',
          ),
        z.string().min(1),
      )
      .default({}),
    proyectos: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((interests, ctx) => {
    for (const [lista, categoria] of Object.entries(interests.awesome_listas)) {
      if (!(categoria in interests.categorias)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['awesome_listas', lista],
          message: `la categoría "${categoria}" no existe en categorias`,
        });
      }
    }
    // Una categoría con mínimo propio por encima del techo dejaría una consulta imposible.
    const max = interests.reglas_globales.estrellas_max;
    if (max === undefined) return;
    for (const [id, category] of Object.entries(interests.categorias)) {
      if (
        category.estrellas_min !== undefined &&
        category.estrellas_min >= max
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['categorias', id, 'estrellas_min'],
          message:
            'estrellas_min debe ser menor que reglas_globales.estrellas_max',
        });
      }
    }
  });

export type Interests = z.infer<typeof interestsSchema>;
export type Category = z.infer<typeof categorySchema>;

export const scoringSchema = z
  .object({
    candidateId: z.string().min(1),
    week: z.string().regex(/^\d{4}-W\d{2}$/, 'semana ISO esperada: YYYY-Www'),
    agent: z.enum(['antigravity', 'claude-code']),
    score: z.number().int().min(1).max(10),
    categoria: z.string().min(1),
    proyectosAfectados: z.array(z.string()),
    porQue: z.string().min(1),
    comoIntegrar: z.string().min(1),
    riesgos: z.array(z.string()),
    usoBrowser: z.boolean(),
  })
  .strict();

export type Scoring = z.infer<typeof scoringSchema>;

export const CATALOG_ESTADOS = [
  'candidato',
  'probado',
  'adoptado',
  'descartado',
] as const;

/** Fila de Catalogo.md exportada a catalog.json (Plan §3). */
export const catalogEntrySchema = z
  .object({
    nombre: z.string().min(1),
    tipo: z.string(),
    categoria: z.string(),
    estado: z.enum(CATALOG_ESTADOS),
    /** `baseline` o semana ISO `YYYY-Www`. */
    semana: z.string(),
    /** `null` cuando la celda es `—` o está vacía. */
    score: z.number().nullable(),
    nota: z.string(),
    /** `null` cuando la celda es `—` o está vacía. */
    enlace: z.string().nullable(),
    /** `owner/repo` en minúsculas si se deduce del enlace o del nombre. */
    repo: z.string().nullable(),
  })
  .strict();

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogSchema = z.array(catalogEntrySchema);
