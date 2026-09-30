import fs from 'node:fs/promises';
import { beforeEach, expect, test, vi } from 'vitest';
import { processBatchResults } from './index.js';

vi.mock('node:fs/promises');
vi.mock('../db/index.js', () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ onConflictDoNothing: () => {} }) }),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('processBatchResults parses valid scoring json', async () => {
  const mockData = [
    {
      candidateId: 'test-1',
      week: '2026-W39',
      agent: 'antigravity',
      score: 8,
      categoria: 'agent-skill',
      proyectosAfectados: [],
      porQue: 'test',
      comoIntegrar: 'test',
      riesgos: [],
      usoBrowser: false,
    },
  ];

  vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(mockData));

  const results = await processBatchResults('2026-W39', '/mock/repo');
  expect(results).toHaveLength(1);
  expect(results[0].candidateId).toBe('test-1');
});

test('processBatchResults fails on invalid json', async () => {
  vi.spyOn(fs, 'readFile').mockResolvedValue('invalid');
  await expect(processBatchResults('2026-W39', '/mock/repo')).rejects.toThrow(
    'scoring.json is not valid JSON',
  );
});

test('processBatchResults fails on invalid schema', async () => {
  vi.spyOn(fs, 'readFile').mockResolvedValue(
    JSON.stringify([{ candidateId: 'test-1' }]),
  );
  await expect(processBatchResults('2026-W39', '/mock/repo')).rejects.toThrow(
    'Validation failed for scoring at index 0',
  );
});
