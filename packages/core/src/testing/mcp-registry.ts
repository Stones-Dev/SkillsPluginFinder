// Fixtures y manejadores de msw con respuestas reales grabadas el 2026-10-02 (ver
// `tests/fixtures/mcp-registry/versions.json`) para los tests del colector `mcp-registry`:
// tres páginas reales de `registry.modelcontextprotocol.io/v0.1/servers` de una ventana de 4 h
// (246 servidores, paginación natural de 100 en 100) y los objetos GraphQL reales de GitHub de
// todos sus repos, pedidos con las mismas consultas que usa el colector. No forma parte de la API.
import fs from 'node:fs';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import type { GraphqlRepo } from '../collectors/github-graphql.js';

const dir = path.resolve(
  import.meta.dirname,
  '../../tests/fixtures/mcp-registry',
);
const readJson = (name: string) =>
  JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'));

type Page = {
  servers: {
    server: {
      name: string;
      version?: string;
      repository?: { url?: string; source?: string };
      packages?: { registryType?: string; identifier?: string }[];
      remotes?: { type?: string }[];
    };
    _meta?: Record<string, { status?: string; publishedAt?: string }>;
  }[];
  metadata?: { nextCursor?: string | null };
};

const versions = readJson('versions.json') as {
  recordedAt: string;
  since: string;
  pages: number;
  rows: number;
};
const pages = [1, 2, 3].map((i) => readJson(`registry.page${i}.json`) as Page);
const graphql = readJson('github.graphql.repos.json') as {
  objects: Record<string, GraphqlRepo>;
  notFound: string[];
};

export const mcpFixtures = {
  versions,
  pages,
  rows: pages.flatMap((p) => p.servers),
  probe: readJson('registry.probe.json') as Page,
  graphqlObjects: graphql.objects,
  notFound: graphql.notFound,
};

/** Lo que el servidor simulado ha visto y cómo debe comportarse. */
export type McpServerState = {
  registryRequests: { url: string; params: Record<string, string> }[];
  graphqlRequests: { names: string[]; full: boolean }[];
  /** `ok`: sirve las páginas reales · `empty`: ninguna novedad · `down`: 503 siempre · `flaky`: 500 la primera vez. */
  registryMode: 'ok' | 'empty' | 'down' | 'flaky';
  /** Nombres (en minúsculas) cuyo lote GraphQL contesta 504. */
  graphqlFailFor: Set<string>;
  graphqlUnauthorized: boolean;
  flakyServed: number;
};

export const newMcpState = (): McpServerState => ({
  registryRequests: [],
  graphqlRequests: [],
  registryMode: 'ok',
  graphqlFailFor: new Set(),
  graphqlUnauthorized: false,
  flakyServed: 0,
});

const ALIAS =
  /(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ ([^}]*)/g;

/** Manejadores de `registry.modelcontextprotocol.io` y de `api.github.com/graphql`. */
export function mcpHandlers(state: McpServerState) {
  return [
    http.get(
      'https://registry.modelcontextprotocol.io/v0.1/servers',
      ({ request }) => {
        const params = Object.fromEntries(new URL(request.url).searchParams);
        state.registryRequests.push({ url: request.url, params });
        if (state.registryMode === 'down') {
          return HttpResponse.json({ error: 'unavailable' }, { status: 503 });
        }
        if (state.registryMode === 'flaky' && state.flakyServed++ === 0) {
          return HttpResponse.json({ error: 'boom' }, { status: 500 });
        }
        if (params.limit === '1') return HttpResponse.json(mcpFixtures.probe);
        if (state.registryMode === 'empty') {
          return HttpResponse.json({ servers: [], metadata: { count: 0 } });
        }
        // La paginación real: sin cursor la primera, y cada una apunta a la siguiente.
        const at = params.cursor
          ? pages.findIndex((p) => p.metadata?.nextCursor === params.cursor) + 1
          : 0;
        if (at < 1 && params.cursor) {
          return HttpResponse.json(
            { error: 'cursor desconocido' },
            { status: 400 },
          );
        }
        return HttpResponse.json(pages[at]);
      },
    ),
    http.post('https://api.github.com/graphql', async ({ request }) => {
      if (state.graphqlUnauthorized) {
        return HttpResponse.json(
          { message: 'Bad credentials' },
          { status: 401 },
        );
      }
      const { query } = (await request.json()) as { query: string };
      const aliases = [...query.matchAll(ALIAS)].map((m) => ({
        alias: m[1],
        name: `${m[2]}/${m[3]}`,
        full: m[4].includes('databaseId'),
      }));
      state.graphqlRequests.push({
        names: aliases.map((a) => a.name),
        full: aliases[0]?.full ?? false,
      });
      if (aliases.some((a) => state.graphqlFailFor.has(a.name.toLowerCase()))) {
        return HttpResponse.json({ message: 'timeout' }, { status: 504 });
      }
      const data: Record<string, unknown> = { rateLimit: { cost: 1 } };
      const errors: unknown[] = [];
      for (const { alias, name } of aliases) {
        const found = mcpFixtures.graphqlObjects[name.toLowerCase()];
        data[alias] = found ?? null;
        if (!found) {
          // El error real de GitHub para un repo que ya no existe
          errors.push({
            type: 'NOT_FOUND',
            path: [alias],
            message: `Could not resolve to a Repository with the name '${name}'.`,
          });
        }
      }
      return HttpResponse.json(errors.length > 0 ? { data, errors } : { data });
    }),
  ];
}
