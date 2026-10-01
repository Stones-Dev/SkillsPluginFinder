import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Los candidatos no viven aquí: están en data/candidates/YYYY-Www.json (versionado,
// con todos los campos del Plan §4). La base solo guarda lo que no cabe en ficheros.

export const seen = sqliteTable('seen', {
  id: text('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull().unique(),
});

export const scorings = sqliteTable('scorings', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').notNull(),
  week: text('week').notNull(),
  agent: text('agent').notNull(),
  score: real('score').notNull(),
  categoria: text('categoria').notNull(),
  proyectosAfectados: text('proyectos_afectados', { mode: 'json' }).$type<
    string[]
  >(),
  porQue: text('por_que').notNull(),
  comoIntegrar: text('como_integrar').notNull(),
  riesgos: text('riesgos', { mode: 'json' }).$type<string[]>(),
  usoBrowser: integer('uso_browser', { mode: 'boolean' }).notNull(),
});

/** Una fila por ejecución de cualquiera de las dos mitades (RF-10, Plan §4). */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  half: text('half', { enum: ['collect', 'evaluate', 'review'] }).notNull(),
  week: text('week').notNull(),
  trigger: text('trigger').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at').notNull(),
  stats: text('stats', { mode: 'json' })
    .$type<Record<string, number>>()
    .notNull(),
  errorsBySource: text('errors_by_source', { mode: 'json' })
    .$type<{ source: string; query?: string; message: string }[]>()
    .notNull(),
});
