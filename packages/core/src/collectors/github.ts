import { request } from 'undici';

export async function collectFromGithub(token: string, queries: string[]) {
  const candidates = [];
  for (const q of queries) {
    const headers: Record<string, string> = {
      'User-Agent': 'SkillsPluginFinder',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await request(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}`,
      { headers },
    );
    const data: any = await res.body.json();
    if (data.items) {
      candidates.push(...data.items);
    }
  }
  return candidates;
}
