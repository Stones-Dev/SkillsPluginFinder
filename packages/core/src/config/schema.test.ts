import { expect, test } from 'vitest';
import { interestsSchema } from './schema.js';

test('interestsSchema defaults', () => {
  const result = interestsSchema.parse({});
  expect(result.categorias).toEqual({});
  expect(result.excluir).toEqual([]);
  expect(result.proyectos).toEqual([]);
  expect(result.reglas_globales.estrellas_min).toBe(50);
});
