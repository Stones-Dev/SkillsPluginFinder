import { request } from 'undici';

export async function collectFromGithub(token: string, queries: string[]) {
  // Skeleton implementation for github collector
  const candidates = [];
  for (const q of queries) {
    const res = await request(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}`,
      {
        headers: {
          'User-Agent': 'SkillsPluginFinder',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    const data: any = await res.body.json();
    if (data.items) {
      candidates.push(...data.items);
    }
  }
  return candidates;
}
