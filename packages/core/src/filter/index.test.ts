import { expect, test } from 'vitest';
import type { Interests } from '../config/schema.js';
import { filterCandidates } from './index.js';

test('filterCandidates applies rules and exclusions', () => {
  const candidates = [
    {
      url: 'ok.com',
      name: 'ok',
      stars: 10,
      createdAt: new Date().toISOString(),
    },
    {
      url: 'bad.com',
      name: 'bad',
      stars: 10,
      createdAt: new Date().toISOString(),
    },
    {
      url: 'nostars.com',
      name: 'nostars',
      stars: 0,
      createdAt: new Date().toISOString(),
    },
    {
      url: 'old.com',
      name: 'old',
      stars: 10,
      createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];

  const interests: Interests = {
    version: 1,
    umbral_score: 7,
    enrich_max: 80,
    ventana_dias: 14,
    idioma_informe: 'es',
    categorias: {},
    proyectos: [],
    excluir: ['bad'],
    reglas_globales: {
      estrellas_min: 5,
      ultimo_commit_max_dias: 365,
      licencias_ok: [],
      excluir_forks_sin_cambios: true,
      excluir_archivados: true,
    },
  };

  const filtered = filterCandidates(candidates, interests);
  expect(filtered.length).toBe(1);
  expect(filtered[0].name).toBe('ok');
});
