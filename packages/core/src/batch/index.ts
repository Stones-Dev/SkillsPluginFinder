import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { candidates as candidatesTable, scorings as scoringsTable } from '../db/schema.js';
import { scoringSchema, Scoring } from '../config/schema.js';

export async function createBatch(candidates: any[], week: string, repoPath: string) {
  if (candidates.length === 0) return false;

  const db = getDb();
  
  // Insert candidates into DB
  const toInsert = candidates.map(c => ({
    id: c.id,
    name: c.name,
    url: c.url,
    source: c.source,
    kind: c.kind,
    description: c.description,
    language: c.language,
    stars: c.stars,
    forks: c.forks,
    createdAt: c.createdAt,
    topics: c.topics,
    categoriaSugerida: c.categoriaSugerida
  }));
  
  for (const item of toInsert) {
    await db.insert(candidatesTable).values(item).onConflictDoNothing();
  }

  // Create batch.md
  const batchDir = path.join(repoPath, 'data', 'batches', week);
  await fs.mkdir(batchDir, { recursive: true });
  
  const batchFilePath = path.join(batchDir, `batch.md`);
  let content = `# Batch ${week}\n\n`;
  content += `<proyectos>\n<!-- TODO: Insert projects from interests -->\n</proyectos>\n\n`;
  content += `<ya_catalogado>\n<!-- TODO: Insert already cataloged items -->\n</ya_catalogado>\n\n`;

  for (const c of candidates) {
    content += `## ${c.name}\n`;
    content += `- **ID:** ${c.id}\n`;
    content += `- **URL:** ${c.url}\n`;
    content += `- **Description:** ${c.description}\n`;
    content += `- **Suggested Category:** ${c.categoriaSugerida}\n`;
    content += `\n`;
  }
  
  await fs.writeFile(batchFilePath, content, 'utf-8');
  return true;
}

export async function processBatchResults(week: string, repoPath: string): Promise<Scoring[]> {
  const scoringPath = path.join(repoPath, 'data', 'batches', week, 'scoring.json');
  
  let raw: string;
  try {
    raw = await fs.readFile(scoringPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`Scoring file not found at ${scoringPath}`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error('scoring.json is not valid JSON');
  }

  if (!Array.isArray(data)) {
    throw new Error('scoring.json must contain an array of scorings');
  }

  const results: Scoring[] = [];
  const db = getDb();

  for (let i = 0; i < data.length; i++) {
    const parsed = scoringSchema.safeParse(data[i]);
    if (!parsed.success) {
      throw new Error(`Validation failed for scoring at index ${i}: ${parsed.error.message}`);
    }
    results.push(parsed.data);
  }

  for (const r of results) {
    await db.insert(scoringsTable).values(r).onConflictDoNothing();
  }

  return results;
}
