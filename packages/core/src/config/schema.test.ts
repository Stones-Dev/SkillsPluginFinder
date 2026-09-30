import { expect, test } from 'vitest';
import { interestsSchema } from './schema.js';

test('interestsSchema defaults', () => {
  const result = interestsSchema.parse({});
  expect(result.categorias).toEqual({});
  expect(result.excluir).toEqual([]);
  expect(result.proyectos).toEqual([]);
  expect(result.reglas_globales.estrellas_min).toBe(50);
});

test('las reglas nuevas son opcionales: sin techo de estrellas y NOASSERTION descartado por defecto', () => {
  const { reglas_globales } = interestsSchema.parse({});
  expect(reglas_globales.estrellas_max).toBeUndefined();
  expect(reglas_globales.licencia_no_reconocida).toBe('descartar');
});

test('estrellas_max y licencia_no_reconocida se validan', () => {
  const parse = (reglas_globales: Record<string, unknown>) =>
    interestsSchema.safeParse({ reglas_globales });

  expect(
    parse({ estrellas_max: 20000, licencia_no_reconocida: 'riesgo' }).success,
  ).toBe(true);
  // un techo por debajo del mínimo descartaría todo en silencio
  const inverted = parse({ estrellas_min: 50, estrellas_max: 50 });
  expect(inverted.success).toBe(false);
  expect(inverted.error?.issues[0]).toMatchObject({
    path: ['reglas_globales', 'estrellas_max'],
    message: 'estrellas_max debe ser mayor que estrellas_min',
  });
  expect(parse({ estrellas_max: 0 }).success).toBe(false);
  expect(parse({ licencia_no_reconocida: 'ignorar' }).success).toBe(false);
});

test('una categoría con estrellas_min por encima del techo se rechaza con su ruta', () => {
  const parse = (estrellas_min: number) =>
    interestsSchema.safeParse({
      reglas_globales: { estrellas_min: 50, estrellas_max: 20000 },
      categorias: { c: { nombre: 'C', peso: 1, estrellas_min } },
    });

  expect(parse(5).success).toBe(true);
  expect(parse(19999).success).toBe(true);
  const bad = parse(20000);
  expect(bad.success).toBe(false);
  expect(bad.error?.issues[0]).toMatchObject({
    path: ['categorias', 'c', 'estrellas_min'],
    message: 'estrellas_min debe ser menor que reglas_globales.estrellas_max',
  });
  // sin techo no hay nada que comparar
  expect(
    interestsSchema.safeParse({
      categorias: { c: { nombre: 'C', peso: 1, estrellas_min: 99999 } },
    }).success,
  ).toBe(true);
});
