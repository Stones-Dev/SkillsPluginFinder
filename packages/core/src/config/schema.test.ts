import { expect, test } from 'vitest';
import { interestsSchema } from './schema.js';

test('interestsSchema defaults', () => {
  const result = interestsSchema.parse({});
  expect(result.categorias).toEqual({});
  expect(result.topics).toEqual([]);
  expect(result.keywords).toEqual([]);
  expect(result.proyectos).toEqual([]);
  expect(result.exclusiones).toEqual([]);
  expect(result.reglas.minStars).toBe(0);
  expect(result.reglas.maxAgeDays).toBe(365);
  expect(result.reglas.requireLicense).toBe(true);
});
