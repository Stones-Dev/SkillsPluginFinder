import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'yaml';
import { type Interests, interestsSchema } from '../config/schema.js';

export async function readInterestsFromVault(
  vaultPath: string,
): Promise<Interests> {
  const file = await fs.readFile(path.join(vaultPath, 'Intereses.md'), 'utf-8');
  const { content } = matter(file);

  // Extract yaml code block
  const match = content.match(/```yaml\n([\s\S]*?)```/);
  if (!match) {
    throw new Error('No yaml code block found in Intereses.md');
  }

  const parsedYaml = yaml.parse(match[1]);
  return interestsSchema.parse(parsedYaml);
}

export async function writeInterestsToVault(
  vaultPath: string,
  interests: Interests,
): Promise<void> {
  const filePath = path.join(vaultPath, 'Intereses.md');
  const file = await fs.readFile(filePath, 'utf-8');
  const { data, content } = matter(file);

  const newYaml = yaml.stringify(interests);
  const newContent = content.replace(
    /```yaml\n[\s\S]*?```/,
    `\`\`\`yaml\n${newYaml}\`\`\``,
  );

  const result = matter.stringify(newContent, data);
  await fs.writeFile(filePath, result, 'utf-8');
}

export async function syncInterests(
  vaultPath: string,
  repoPath: string,
): Promise<void> {
  const vaultInterests = await readInterestsFromVault(vaultPath);
  const yamlPath = path.join(repoPath, 'interests.yaml');
  await fs.writeFile(yamlPath, yaml.stringify(vaultInterests), 'utf-8');
}
