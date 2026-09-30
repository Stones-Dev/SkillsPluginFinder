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
