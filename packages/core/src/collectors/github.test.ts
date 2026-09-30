import fs from 'node:fs/promises';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { collectFromGithub } from './github.js';

const server = setupServer(
  http.get('https://api.github.com/search/repositories', async () => {
    const fixturePath = path.resolve(
      import.meta.dirname,
      '../../tests/fixtures/github-search/response.json',
    );
    const data = await fs.readFile(fixturePath, 'utf-8');
    return HttpResponse.json(JSON.parse(data));
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

test('collectFromGithub fetches and parses candidates', async () => {
  const result = await collectFromGithub('', ['claude code skill']);
  expect(result.length).toBeGreaterThan(0);
  expect(result[0].name).toBeDefined();
});
