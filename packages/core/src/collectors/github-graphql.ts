import type { GithubClient } from './github-client.js';
import type { GithubRepo } from './github.js';

/**
 * Repos por consulta. Con 100 y el detalle completo GitHub contesta 504 (medido el
 * 2026-10-02); con 25 la consulta de solo estrellas tarda ~1,2 s y la completa ~5 s.
 */
export const GRAPHQL_BATCH = 25;

/** Primera etapa: lo mínimo para decidir si un repo merece el detalle. */
export const STARS_FIELDS = 'nameWithOwner stargazerCount';

/** Segunda etapa: los campos que usa el pipeline (los mismos que `GithubRepo`). */
export const REPO_FIELDS =
  'nameWithOwner databaseId url description stargazerCount forkCount createdAt updatedAt pushedAt isArchived isFork primaryLanguage { name } licenseInfo { key name spdxId } owner { login } defaultBranchRef { name } repositoryTopics(first: 20) { nodes { topic { name } } } issues(states: OPEN) { totalCount }';

export type GraphqlRepo = {
  nameWithOwner: string;
  stargazerCount: number;
  databaseId?: number;
  url?: string;
  description?: string | null;
  forkCount?: number;
  createdAt?: string;
  updatedAt?: string;
  pushedAt?: string | null;
  isArchived?: boolean;
  isFork?: boolean;
  primaryLanguage?: { name: string } | null;
  licenseInfo?: { key: string; name: string; spdxId: string | null } | null;
  owner?: { login: string };
  defaultBranchRef?: { name: string } | null;
  repositoryTopics?: { nodes: { topic: { name: string } }[] };
  issues?: { totalCount: number };
};

const NAME = /^[\w.-]+\/[\w.-]+$/;

/** Una consulta con un alias por repo: `r0: repository(owner: "o", name: "n") { … }`. */
export function buildBatchQuery(names: string[], fields: string): string {
  const body = names.map((full, i) => {
    if (!NAME.test(full)) throw new Error(`Nombre de repo no válido: ${full}`);
    const [owner, name] = full.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} }`;
  });
  return `query { rateLimit { cost } ${body.join('\n')} }`;
}

export type BatchResult = {
  /** Por nombre pedido (en minúsculas): el repo, o `null` si ya no existe. */
  repos: Map<string, GraphqlRepo | null>;
  /** Nombres que no se pudieron consultar (error de red, 5xx, límite): se reintentan más tarde. */
  failed: string[];
  /** Puntos del cubo GraphQL que ha costado la consulta. */
  cost: number;
};

type PartialResponse = {
  data?: Record<string, unknown> | null;
  errors?: { type?: string; path?: unknown[] }[];
};

/**
 * Consulta un lote de repos. GitHub contesta 200 con los que existen y un error
 * `NOT_FOUND` por cada uno que no (Octokit lo lanza como `GraphqlResponseError`
 * con `data` parcial: se aprovecha). Cualquier otra cosa (504, límite secundario,
 * red) deja el lote entero en `failed`. Un 401 se relanza: el token no vale.
 */
export async function queryRepoBatch(
  octokit: GithubClient,
  names: string[],
  fields: string,
): Promise<BatchResult> {
  const repos = new Map<string, GraphqlRepo | null>();
  let response: PartialResponse;
  try {
    // `octokit.graphql` resuelve con el `data` directamente (sin `errors`: si los hay, lanza)
    response = {
      data: (await octokit.graphql(buildBatchQuery(names, fields))) as Record<
        string,
        unknown
      >,
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) throw err;
    const partial = err as {
      data?: PartialResponse['data'];
      errors?: PartialResponse['errors'];
    };
    // GraphqlResponseError: hay `data` (parcial) y `errors`
    if (partial.data && Array.isArray(partial.errors)) {
      response = { data: partial.data, errors: partial.errors };
    } else {
      return { repos, failed: [...names], cost: 0 };
    }
  }

  const data = response.data ?? {};
  const errorsByAlias = new Map<string, string | undefined>();
  for (const e of response.errors ?? []) {
    const alias = e.path?.[0];
    if (typeof alias === 'string') errorsByAlias.set(alias, e.type);
  }
  const failed: string[] = [];
  names.forEach((name, i) => {
    const found = data[`r${i}`] as GraphqlRepo | null | undefined;
    if (found) repos.set(name.toLowerCase(), found);
    else if (
      errorsByAlias.get(`r${i}`) === 'NOT_FOUND' ||
      (found === null && !errorsByAlias.has(`r${i}`))
    ) {
      repos.set(name.toLowerCase(), null);
    } else {
      failed.push(name);
    }
  });
  const cost = (data.rateLimit as { cost?: number } | undefined)?.cost ?? 0;
  return { repos, failed, cost };
}

/** El repo de GraphQL con la forma de la API REST que usa el resto del pipeline. */
export function toGithubRepo(g: GraphqlRepo): GithubRepo {
  const [, name] = g.nameWithOwner.split('/');
  const createdAt = g.createdAt ?? new Date(0).toISOString();
  return {
    id: g.databaseId ?? 0,
    name,
    full_name: g.nameWithOwner,
    html_url: g.url ?? `https://github.com/${g.nameWithOwner}`,
    description: g.description ?? null,
    language: g.primaryLanguage?.name ?? null,
    stargazers_count: g.stargazerCount,
    forks_count: g.forkCount ?? 0,
    open_issues_count: g.issues?.totalCount ?? 0,
    created_at: createdAt,
    updated_at: g.updatedAt ?? createdAt,
    // un repo vacío no tiene push: se usa su creación, como haría el filtro de inactividad
    pushed_at: g.pushedAt ?? createdAt,
    license: g.licenseInfo
      ? {
          key: g.licenseInfo.key,
          name: g.licenseInfo.name,
          spdx_id: g.licenseInfo.spdxId,
        }
      : null,
    topics: g.repositoryTopics?.nodes.map((n) => n.topic.name) ?? [],
    archived: g.isArchived ?? false,
    fork: g.isFork ?? false,
    default_branch: g.defaultBranchRef?.name ?? 'main',
    owner: { login: g.owner?.login ?? g.nameWithOwner.split('/')[0] },
  };
}
