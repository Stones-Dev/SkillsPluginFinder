// Fixtures y manejadores de msw con respuestas reales de GitHub grabadas el 2026-10-01 (ver
// `tests/fixtures/anthropic/versions.json`) para los tests del colector `anthropic-skills`. No forma
// parte de la API.
import fs from 'node:fs';
import path from 'node:path';
import { http, HttpResponse } from 'msw';

const MARKETPLACE_REPO = 'anthropics/claude-plugins-official';
const SKILLS_REPO = 'anthropics/skills';

const dir = path.resolve(import.meta.dirname, '../../tests/fixtures/anthropic');
const readJson = (name: string) =>
  JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'));
const readText = (name: string) => fs.readFileSync(`${dir}/${name}`, 'utf8');
const versions = readJson('versions.json') as {
  skills: { head: string; oldHead: string; headCommitsEtag: string };
  plugins: { head: string; oldHead: string; headCommitsEtag: string };
};
const skillsCommits = readJson('skills.commits.json') as {
  etag: string;
  body: { sha: string; commit: { message: string } }[];
};
const skillsListing = {
  head: readJson('skills.listing.head.json').body as ListingItem[],
  old: readJson('skills.listing.old.json').body as ListingItem[],
};
const marketplace = {
  head: JSON.parse(readText('plugins.marketplace.head.json')) as Marketplace,
  old: JSON.parse(readText('plugins.marketplace.old.json')) as Marketplace,
};
const repoFixtures = new Map<string, { status: number; body: unknown }>(
  fs
    .readdirSync(`${dir}/repos`)
    .map((f) => [
      f.replace('__', '/').replace(/\.json$/, ''),
      JSON.parse(fs.readFileSync(`${dir}/repos/${f}`, 'utf8')),
    ]),
);
export type ListingItem = { name: string; type: string; sha: string };
export type Marketplace = {
  plugins: { name: string; description?: string; source?: unknown }[];
};

// Lo que cambia, medido con otro script (huella con y sin los pines) sobre los mismos dos ficheros.
const NEW_PLUGINS = [
  'govtribe',
  'linq-alpha',
  'math-proof',
  'vanguard-advisor-tools',
];
const CHANGED_PLUGINS = [
  'aws-startup-advisor',
  'code-modernization',
  'postman',
];

export const anthropicFixtures = {
  dir,
  readText,
  versions,
  skillsCommits,
  skillsListing,
  marketplace,
  repoFixtures,
  NEW_PLUGINS,
  CHANGED_PLUGINS,
};

/** Lo que el servidor simulado ha visto y cómo debe comportarse. */
export type AnthropicServerState = {
  requests: { url: string; ifNoneMatch: string | null }[];
  marketplaceMode: 'ok' | 'invalid';
  repoStatus: Map<string, number>;
};

export const newAnthropicState = (): AnthropicServerState => ({
  requests: [],
  marketplaceMode: 'ok',
  repoStatus: new Map(),
});

/** Manejadores de `api.github.com` que sirven las respuestas reales grabadas. */
export function anthropicHandlers(state: AnthropicServerState) {
  return [
    http.get(
      'https://api.github.com/repos/:owner/:repo/commits',
      ({ request, params }) => {
        const repo = `${params.owner}/${params.repo}`;
        const ifNoneMatch = request.headers.get('if-none-match');
        state.requests.push({ url: request.url, ifNoneMatch });
        const perPage = Number(
          new URL(request.url).searchParams.get('per_page'),
        );
        const real =
          repo === SKILLS_REPO
            ? {
                etag: versions.skills.headCommitsEtag,
                body: skillsCommits.body,
              }
            : {
                etag: versions.plugins.headCommitsEtag,
                body: readJson('plugins.commits.json').body,
              };
        if (ifNoneMatch === real.etag) {
          return new HttpResponse(null, {
            status: 304,
            headers: { etag: real.etag },
          });
        }
        return HttpResponse.json(real.body.slice(0, perPage), {
          headers: { etag: real.etag },
        });
      },
    ),
    http.get(
      'https://api.github.com/repos/:owner/:repo/contents/*',
      ({ request, params }) => {
        const repo = `${params.owner}/${params.repo}`;
        const file = String(params[0] ?? '');
        state.requests.push({ url: request.url, ifNoneMatch: null });
        if (repo === SKILLS_REPO && file === 'skills') {
          return HttpResponse.json(skillsListing.head);
        }
        const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(file);
        if (repo === SKILLS_REPO && skill) {
          const name = `skills.SKILL.${skill[1]}.md`;
          return fs.existsSync(`${dir}/${name}`)
            ? new HttpResponse(readText(name), {
                headers: {
                  'content-type':
                    'application/vnd.github.raw+json; charset=utf-8',
                },
              })
            : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
        }
        if (
          repo === MARKETPLACE_REPO &&
          file === '.claude-plugin/marketplace.json'
        ) {
          return new HttpResponse(
            state.marketplaceMode === 'invalid'
              ? '{ no es json'
              : readText('plugins.marketplace.head.json'),
            {
              headers: {
                'content-type':
                  'application/vnd.github.raw+json; charset=utf-8',
              },
            },
          );
        }
        return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      },
    ),
    http.get(
      'https://api.github.com/repos/:owner/:repo',
      ({ request, params }) => {
        const repo = `${params.owner}/${params.repo}`.toLowerCase();
        state.requests.push({ url: request.url, ifNoneMatch: null });
        const forced = state.repoStatus.get(repo);
        if (forced)
          return HttpResponse.json({ message: 'forced' }, { status: forced });
        const fixture = repoFixtures.get(repo);
        return fixture
          ? HttpResponse.json(fixture.body as object, {
              status: fixture.status,
            })
          : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      },
    ),
  ];
}
