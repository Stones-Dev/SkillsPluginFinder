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
    categorias: {},
    topics: [],
    keywords: [],
    proyectos: [],
    exclusiones: ['bad'],
    reglas: { minStars: 5, maxAgeDays: 365, requireLicense: false },
  };

  const filtered = filterCandidates(candidates, interests);
  expect(filtered.length).toBe(1);
  expect(filtered[0].name).toBe('ok');
});
