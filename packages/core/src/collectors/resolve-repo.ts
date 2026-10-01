import type { GithubClient } from './github-client.js';
import type { GithubRepo } from './github.js';

/** Un repo que ya no existe (borrado, privado o retirado): se da por visto. */
const GONE = new Set([404, 410, 451]);

export type Resolution =
  | { kind: 'ok'; link: string; repo: GithubRepo }
  | { kind: 'gone'; link: string }
  | { kind: 'error'; link: string };

const statusOf = (err: unknown) => (err as { status?: number }).status;

/**
 * `GET /repos/{owner}/{repo}` de un `owner/repo` que sale de una fuente. Si el
 * repo se renombró, GitHub redirige y `repo.full_name` trae el nombre vigente.
 * 404/410/451 → `gone`; cualquier otro fallo → `error` (transitorio, se reintenta
 * la semana siguiente). Un 401 se relanza: el token es inválido para todo.
 */
export async function resolveGithubRepo(
  octokit: GithubClient,
  link: string,
): Promise<Resolution> {
  const [owner, repo] = link.split('/');
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo,
    });
    return { kind: 'ok', link, repo: res.data as unknown as GithubRepo };
  } catch (err) {
    const status = statusOf(err);
    if (status === 401) throw err;
    if (status !== undefined && GONE.has(status)) return { kind: 'gone', link };
    return { kind: 'error', link };
  }
}
