import type { GithubClient } from '../collectors/github-client.js';
import type { Candidate } from '../normalize/candidate.js';

export const README_EXCERPT_MAX = 2000;

/** Scripts que se ejecutan al instalar el paquete (Constitución §6). */
const LIFECYCLE = ['preinstall', 'install', 'postinstall'] as const;

export type Enrichment = {
  /** README sin HTML, badges ni imágenes, recortado a 2.000 caracteres. */
  readmeExcerpt: string | null;
  /** Nº de contribuidores (la API cuenta solo los que tienen commits). */
  contributors: number | null;
  singleMaintainer: boolean | null;
  /** Scripts de instalación de `package.json`; `null` si no hay `package.json` en la raíz. */
  lifecycleScripts: string[] | null;
  notes: string[];
};

/**
 * Deja el texto útil del README: quita comentarios, imágenes/badges y etiquetas
 * HTML (conservando el texto) y recorta a `max` caracteres. El resultado sigue
 * siendo contenido no confiable: el batch lo marca como dato, no como instrucción.
 */
export function cleanReadme(raw: string, max = README_EXCERPT_MAX): string {
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // par sustituto partido
  return `${cut.trimEnd()}…`;
}

/** Nombres de los scripts de instalación presentes en un `package.json`. */
export function lifecycleScripts(pkg: unknown): string[] {
  const scripts = (pkg as { scripts?: Record<string, unknown> } | null)
    ?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  return LIFECYCLE.filter((name) => typeof scripts[name] === 'string');
}

/** Con `per_page=1`, el número de la última página es el nº de contribuidores. */
export function contributorCount(
  linkHeader: string | undefined,
  itemsOnPage: number,
): number {
  const last = linkHeader?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return last ? Number(last[1]) : itemsOnPage;
}

const statusOf = (err: unknown) => (err as { status?: number }).status;

export async function fetchReadme(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/readme', {
      owner,
      repo,
      mediaType: { format: 'raw' },
    });
    const data = res.data as unknown;
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

export async function fetchContributors(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<number> {
  const res = await octokit.request('GET /repos/{owner}/{repo}/contributors', {
    owner,
    repo,
    per_page: 1,
  });
  const items = Array.isArray(res.data) ? res.data.length : 0;
  return contributorCount(res.headers.link, items);
}

/** `null` si no hay `package.json` en la raíz; solo se lee el texto, nunca se instala nada. */
export async function fetchLifecycleScripts(
  octokit: GithubClient,
  owner: string,
  repo: string,
): Promise<string[] | null> {
  try {
    const res = await octokit.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner, repo, path: 'package.json', mediaType: { format: 'raw' } },
    );
    // Con `format: raw` Octokit devuelve el texto, o el objeto ya parseado si
    // el content-type se interpreta como JSON.
    const data = res.data as unknown;
    return lifecycleScripts(typeof data === 'string' ? JSON.parse(data) : data);
  } catch (err) {
    if (statusOf(err) === 404) return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Enriquecimiento mínimo por API de un repositorio (README, contribuidores y
 * scripts de instalación). Un fallo puntual queda anotado en `notes`; un 401
 * se propaga porque invalida todo el token.
 */
export async function enrichGithubRepo(
  octokit: GithubClient,
  fullName: string,
): Promise<Enrichment> {
  const [owner, repo] = fullName.split('/');
  const notes: string[] = [];

  const attempt = async <T>(label: string, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (statusOf(err) === 401) throw err;
      notes.push(
        `${label} no disponible: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };

  const readme = await attempt('README', () =>
    fetchReadme(octokit, owner, repo),
  );
  const contributors = await attempt('Contribuidores', () =>
    fetchContributors(octokit, owner, repo),
  );
  const scripts = await attempt('package.json', () =>
    fetchLifecycleScripts(octokit, owner, repo),
  );

  return {
    readmeExcerpt: readme === null ? null : cleanReadme(readme),
    contributors,
    singleMaintainer: contributors === null ? null : contributors === 1,
    lifecycleScripts: scripts,
    notes,
  };
}

/**
 * Incorpora el enriquecimiento al candidato. `postinstall` es `true` si hay
 * scripts de instalación, `false` si hay `package.json` sin ellos y queda sin
 * definir cuando no se pudo saber (sin `package.json` en la raíz o error).
 */
export function applyEnrichment(
  candidate: Candidate,
  enrichment: Enrichment,
): Candidate {
  const { lifecycleScripts: scripts } = enrichment;
  return {
    ...candidate,
    contributors: enrichment.contributors ?? undefined,
    readmeExcerpt: enrichment.readmeExcerpt ?? undefined,
    risk: {
      ...candidate.risk,
      singleMaintainer: enrichment.singleMaintainer ?? undefined,
      lifecycleScripts: scripts ?? undefined,
      postinstall: scripts ? scripts.length > 0 : undefined,
      notes: [...candidate.risk.notes, ...enrichment.notes],
    },
  };
}
