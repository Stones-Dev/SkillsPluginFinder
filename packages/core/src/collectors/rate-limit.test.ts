import fs from 'node:fs';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import {
  RATE_LIMIT_URL,
  type RateLimits,
  checkRateLimits,
  fetchRateLimits,
  formatRateLimits,
} from './rate-limit.js';

// Respuesta real de GET /rate_limit grabada con un PAT fine-grained de solo lectura.
const recorded = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../tests/fixtures/github-quota/rate_limit.json',
    ),
    'utf8',
  ),
) as { status: number; body: unknown };

let requests: Request[] = [];
const server = setupServer();
const respond = (body: unknown, status = 200) => {
  server.use(
    http.get(RATE_LIMIT_URL, ({ request }) => {
      requests.push(request);
      return HttpResponse.json(body as Record<string, unknown>, { status });
    }),
  );
};

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  requests = [];
});
afterAll(() => server.close());

test('lee core y search de la respuesta real y pasa la fecha de renovación a ISO', async () => {
  respond(recorded.body);
  const limits = await fetchRateLimits('token-de-prueba');

  expect(limits.core).toMatchObject({ limit: 5000, remaining: 5000 });
  expect(limits.search).toMatchObject({ limit: 30, remaining: 30 });
  expect(limits.core.reset).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/,
  );
  const raw = (recorded.body as { resources: { core: { reset: number } } })
    .resources.core.reset;
  expect(Date.parse(limits.core.reset)).toBe(raw * 1000);
});

test('envía el token como Bearer, con User-Agent y versión de API', async () => {
  respond(recorded.body);
  await fetchRateLimits('token-de-prueba');

  expect(requests).toHaveLength(1);
  const headers = requests[0].headers;
  expect(headers.get('authorization')).toBe('Bearer token-de-prueba');
  expect(headers.get('user-agent')).toMatch(/^SkillsPluginFinder\//);
  expect(headers.get('x-github-api-version')).toBe('2022-11-28');
});

test('sin token aborta antes de hacer ninguna petición', async () => {
  respond(recorded.body);
  await expect(fetchRateLimits(undefined)).rejects.toThrow(
    'GITHUB_TOKEN es obligatorio',
  );
  await expect(fetchRateLimits('   ')).rejects.toThrow(
    'GITHUB_TOKEN es obligatorio',
  );
  expect(requests).toHaveLength(0);
});

test('un 401 dice que el token está rechazado y ningún error contiene el token', async () => {
  respond({ message: 'Bad credentials' }, 401);
  const error = await fetchRateLimits('secreto-que-no-debe-salir').catch(
    (e: Error) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('GITHUB_TOKEN rechazado');
  expect((error as Error).message).not.toContain('secreto-que-no-debe-salir');

  respond({ message: 'Server Error' }, 500);
  const other = await fetchRateLimits('secreto-que-no-debe-salir').catch(
    (e: Error) => e,
  );
  expect((other as Error).message).toContain('500');
  expect((other as Error).message).not.toContain('secreto-que-no-debe-salir');
});

test('una respuesta sin el cubo core o con otro formato se rechaza con el nombre del cubo', async () => {
  respond({ resources: { search: { limit: 30, remaining: 30, reset: 1 } } });
  await expect(fetchRateLimits('t')).rejects.toThrow('cubo "core"');

  respond({
    resources: {
      core: { limit: 5000, remaining: 5000, reset: 1 },
      search: { limit: '30', remaining: 30, reset: 1 },
    },
  });
  await expect(fetchRateLimits('t')).rejects.toThrow('cubo "search"');
});

const limits = (
  core: [number, number],
  search: [number, number],
): RateLimits => ({
  core: {
    limit: core[0],
    remaining: core[1],
    reset: '2026-10-05T06:00:00.000Z',
  },
  search: {
    limit: search[0],
    remaining: search[1],
    reset: '2026-10-05T05:01:00.000Z',
  },
});

test('checkRateLimits: un PAT (5.000 y 30) y el token automático de Actions (1.000 y 30) alcanzan; sin token no', () => {
  const need = { core: 400, search: 30 };
  expect(checkRateLimits(limits([5000, 5000], [30, 30]), need)).toEqual([]);
  // documentado por GitHub: 1.000 peticiones por hora y repositorio con el GITHUB_TOKEN de Actions
  expect(checkRateLimits(limits([1000, 1000], [30, 30]), need)).toEqual([]);
  expect(checkRateLimits(limits([60, 60], [10, 10]), need)).toEqual([
    'core: quedan 60 de 60 peticiones por hora y hacen falta 400',
    'search: el límite es de 10 por minuto y hacen falta 30',
  ]);
});

test('checkRateLimits: core mira lo que queda ahora y search mira el límite, no lo que queda en el minuto', () => {
  // ya se gastó casi toda la hora, pero el límite de core es bueno: no alcanza
  expect(checkRateLimits(limits([1000, 350], [30, 30]), { core: 400 })).toEqual(
    ['core: quedan 350 de 1000 peticiones por hora y hacen falta 400'],
  );
  // search con la ventana del minuto vacía: el throttling reparte las búsquedas, no es un problema
  expect(
    checkRateLimits(limits([5000, 5000], [30, 0]), { search: 30 }),
  ).toEqual([]);
  // sin mínimos no se exige nada
  expect(checkRateLimits(limits([60, 0], [10, 0]), {})).toEqual([]);
});

test('formatRateLimits enseña los dos cubos y la renovación, sin nada del token', () => {
  const lines = formatRateLimits(limits([1000, 998], [30, 30]));
  expect(lines).toEqual([
    'Cuota de la API de GitHub (GET /rate_limit)',
    '  core   límite 1000 por hora · quedan 998 · se renueva 2026-10-05T06:00:00.000Z',
    '  search límite 30 por minuto · quedan 30 · se renueva 2026-10-05T05:01:00.000Z',
  ]);
});
