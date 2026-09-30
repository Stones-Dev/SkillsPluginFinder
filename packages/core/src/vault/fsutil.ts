import fs from 'node:fs/promises';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Escritura atómica: fichero temporal en el mismo directorio + rename. Proton
 * Drive puede tener el destino bloqueado mientras sincroniza, así que el rename
 * se reintenta ante EBUSY/EPERM/EACCES (Plan §12). UTF-8 sin BOM.
 */
export async function atomicWriteFile(
  file: string,
  content: string,
  { retries = 5, delayMs = 150 } = {},
): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!code || !RETRYABLE.has(code) || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
