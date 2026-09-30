import { expect, test } from 'vitest';
import { normalizeCandidate } from './index.js';

test('normalizeCandidate maps github properties', () => {
  const raw = {
    full_name: 'test/repo',
    html_url: 'https://github.com/test/repo',
    description: 'A test repo',
    stargazers_count: 42,
  };
  const normalized = normalizeCandidate(raw);

  expect(normalized.name).toBe('test/repo');
  expect(normalized.url).toBe('https://github.com/test/repo');
  expect(normalized.description).toBe('A test repo');
  expect(normalized.stars).toBe(42);
  expect(normalized.source).toBe('github');
  expect(normalized.id).toBeDefined();
});
