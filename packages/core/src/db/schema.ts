import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const candidates = sqliteTable('candidates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  source: text('source').notNull(),
  kind: text('kind').notNull(),
  description: text('description').notNull(),
  language: text('language'),
  stars: integer('stars'),
  forks: integer('forks'),
  createdAt: text('created_at'),
  topics: text('topics', { mode: 'json' }).$type<string[]>(),
  categoriaSugerida: text('categoria_sugerida'),
});

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
  proyectosAfectados: text('proyectos_afectados', { mode: 'json' }).$type<string[]>(),
  porQue: text('por_que').notNull(),
  comoIntegrar: text('como_integrar').notNull(),
  riesgos: text('riesgos', { mode: 'json' }).$type<string[]>(),
  usoBrowser: integer('uso_browser', { mode: 'boolean' }).notNull(),
});
