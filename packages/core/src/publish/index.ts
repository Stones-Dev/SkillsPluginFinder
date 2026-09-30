import fs from 'node:fs/promises';
import path from 'node:path';

export async function publishReport(
  week: string,
  results: any[],
  vaultPath: string,
) {
  const filePath = path.join(vaultPath, `Informes/${week}.md`);
  await fs.mkdir(path.join(vaultPath, 'Informes'), { recursive: true });

  let content = `# Informe ${week}\n\n`;
  content += `Se evaluaron ${results.length} candidatos.\n`;

  await fs.writeFile(filePath, content, 'utf-8');
  return true;
}

export async function updateCatalog(results: any[], vaultPath: string) {
  const catalogPath = path.join(vaultPath, 'Catalogo.md');
  // just append for now
  let append = '';
  for (const r of results) {
    append += `- ${r.name}: ${r.url}\n`;
  }

  try {
    await fs.appendFile(catalogPath, append, 'utf-8');
  } catch (e) {
    await fs.writeFile(catalogPath, `# Catálogo\n\n${append}`, 'utf-8');
  }
  return true;
}
