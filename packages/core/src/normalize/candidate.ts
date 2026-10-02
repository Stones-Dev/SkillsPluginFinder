import { z } from 'zod';

export const SOURCE_IDS = [
  'github-search',
  'awesome-list',
  'anthropic-skills',
  'mcp-registry',
] as const;

export const KINDS = [
  'skill',
  'plugin',
  'mcp-server',
  'agent-skill',
  'library',
  'tool',
  'template',
  'article',
] as const;

/** De qué consulta salió un candidato (para `categoriaSugerida`). */
export const originSchema = z
  .object({
    categoria: z.string().min(1),
    /** `awesome`: salió de una lista `awesome-*`; `query` es el `owner/repo` de la lista. */
    /** `anthropic`: plugin nuevo del marketplace oficial; `query` es `<marketplace>:<plugin>`. */
    /** `registry`: servidor del registro oficial MCP; `query` es su nombre en el registro. */
    tipo: z.enum(['keyword', 'topic', 'awesome', 'anthropic', 'registry']),
    query: z.string().min(1),
  })
  .strict();

export type Origin = z.infer<typeof originSchema>;

/** Plan §4. `raw` se omite: los campos que usa el pipeline están tipados. */
export const candidateSchema = z
  .object({
    /** Estable entre ejecuciones: `github:owner/repo` en minúsculas. */
    id: z.string().min(1),
    /** `owner/repo` tal y como lo escribe GitHub. */
    name: z.string().min(1),
    url: z.string().url(),
    source: z.enum(SOURCE_IDS),
    kind: z.enum(KINDS),
    description: z.string(),
    language: z.string().optional(),
    stars: z.number().int().nonnegative(),
    forks: z.number().int().nonnegative(),
    contributors: z.number().int().nonnegative().optional(),
    createdAt: z.string(),
    /** `pushed_at` de GitHub. */
    lastCommitAt: z.string(),
    /** SPDX; `NOASSERTION` se conserva, sin licencia queda sin definir. */
    license: z.string().optional(),
    topics: z.array(z.string()),
    archived: z.boolean(),
    fork: z.boolean(),
    categoriaSugerida: z.string().min(1),
    categoriasAlternativas: z.array(z.string()),
    origins: z.array(originSchema),
    risk: z
      .object({
        ageDays: z.number().int(),
        postinstall: z.boolean().optional(),
        lifecycleScripts: z.array(z.string()).optional(),
        singleMaintainer: z.boolean().optional(),
        notes: z.array(z.string()),
      })
      .strict(),
    /** README limpio, <= 2.000 caracteres. Contenido no confiable. */
    readmeExcerpt: z.string().optional(),
    foundAt: z.string(),
  })
  .strict();

export type Candidate = z.infer<typeof candidateSchema>;
