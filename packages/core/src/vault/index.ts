import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'yaml';
import { type Interests, interestsSchema } from '../config/schema.js';

export async function readInterestsFromVault(
  vaultPath: string,
): Promise<Interests> {
  const file = await fs.readFile(path.join(vaultPath, 'Intereses.md'), 'utf-8');
  const { data } = matter(file);
  return interestsSchema.parse(data);
}

export async function writeInterestsToVault(
  vaultPath: string,
  interests: Interests,
): Promise<void> {
  const filePath = path.join(vaultPath, 'Intereses.md');
  const file = await fs.readFile(filePath, 'utf-8');
  const parsed = matter(file);
  const newContent = matter.stringify(parsed.content, interests);
  await fs.writeFile(filePath, newContent, 'utf-8');
}

export async function syncInterests(
  vaultPath: string,
  repoPath: string,
): Promise<void> {
  const vaultInterests = await readInterestsFromVault(vaultPath);
  const yamlPath = path.join(repoPath, 'interests.yaml');
  await fs.writeFile(yamlPath, yaml.stringify(vaultInterests), 'utf-8');
}
