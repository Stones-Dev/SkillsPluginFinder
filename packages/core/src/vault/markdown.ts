export type YamlBlock = {
  /** Offset del primer carácter del cuerpo (tras la línea ```yaml). */
  start: number;
  /** Offset del inicio de la línea de cierre ```. */
  end: number;
};

/**
 * Localiza los bloques ```yaml sobre el texto crudo (LF o CRLF, con o sin BOM)
 * devolviendo offsets, para poder reemplazar solo el cuerpo y dejar el resto de
 * la nota byte a byte.
 */
export function findYamlBlocks(text: string): YamlBlock[] {
  const blocks: YamlBlock[] = [];
  let pos = 0;
  let open: number | null = null;

  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '');
    if (open === null) {
      if (/^```yaml[ \t]*$/.test(bare)) open = pos + line.length;
    } else if (/^```[ \t]*$/.test(bare)) {
      blocks.push({ start: open, end: pos });
      open = null;
    }
    pos += line.length;
  }

  if (open !== null) {
    throw new Error('Hay un bloque ```yaml sin cerrar.');
  }
  return blocks;
}

/** Exige exactamente un bloque ```yaml: 0 o varios es ambiguo y aborta. */
export function extractYamlBlock(
  text: string,
  file = 'Intereses.md',
): YamlBlock & { body: string } {
  const blocks = findYamlBlocks(text);
  if (blocks.length !== 1) {
    throw new Error(
      `${file} debe contener exactamente un bloque \`\`\`yaml (hay ${blocks.length}).`,
    );
  }
  const [block] = blocks;
  return { ...block, body: text.slice(block.start, block.end) };
}

// Construido con fromCharCode: ni un literal invisible ni un escape que el
// formateador pueda "normalizar" a un carácter invisible dentro del código.
const BOM = String.fromCharCode(0xfeff);

const stripBom = (text: string) =>
  text.startsWith(BOM) ? text.slice(BOM.length) : text;

/** YAML comparable entre plataformas: sin BOM, LF y un único salto final. */
export function normalizeYaml(text: string): string {
  return `${stripBom(text).replace(/\r\n/g, '\n').trimEnd()}\n`;
}

/**
 * Sustituye solo el cuerpo del bloque ```yaml, respetando el fin de línea de
 * la nota. No reserializa el frontmatter ni toca nada fuera del bloque.
 */
export function replaceYamlBlock(
  text: string,
  newBody: string,
  file = 'Intereses.md',
): string {
  const { start, end } = extractYamlBlock(text, file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = normalizeYaml(newBody).replace(/\n/g, eol);
  return text.slice(0, start) + body + text.slice(end);
}

/** Actualiza únicamente la línea `updated:` del frontmatter (si existe). */
export function setFrontmatterUpdated(text: string, isoDate: string): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const rest = stripBom(text);
  const match = rest.match(/^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (!match) return text;
  const frontmatter = match[2].replace(/^(updated:[ \t]*).*$/m, `$1${isoDate}`);
  return (
    bom + match[1] + frontmatter + rest.slice(match[1].length + match[2].length)
  );
}
