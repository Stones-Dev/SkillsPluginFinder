import fs from 'node:fs/promises';
import path from 'node:path';
import { setFrontmatterUpdated } from '../vault/markdown.js';

/** Esqueleto de `99-Meta/Plantillas/Plantilla Diario.md`, por si la plantilla no está. */
const SKELETON = `---
aliases: []
type: diario
status: active
tags: [diario]
created: YYYY-MM-DD
updated: YYYY-MM-DD
related: []
---

# YYYY-MM-DD

## Prioridades de hoy

## Bucles abiertos

_Tareas o problemas que siguen en curso de días anteriores._

## Notas del día

## Bitácora del agente

_Sección reservada para los resúmenes de las sesiones de IA. No escribir aquí manualmente._
`;

/**
 * Añade `line` al final de la sección «## Bucles abiertos» (la crea al final de la
 * nota si no existe) sin tocar el resto. Misma línea dos veces, una sola vez.
 */
export function insertOpenLoop(text: string, line: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split('\n');
  if (lines.some((l) => l.replace(/\r$/, '') === line)) return text;

  const heading = lines.findIndex((l) => /^## Bucles abiertos\s*$/.test(l));
  if (heading < 0) {
    const body = text.endsWith('\n') ? text : `${text}${eol}`;
    return `${body}${eol}## Bucles abiertos${eol}${eol}${line}${eol}`;
  }
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  let last = heading;
  for (let i = heading + 1; i < end; i++) {
    if (lines[i].trim() !== '') last = i;
  }
  lines.splice(last + 1, 0, `${line}${eol === '\r\n' ? '\r' : ''}`);
  return lines.join('\n');
}

export type DailyUpdate = { file: string; text: string; created: boolean };

/**
 * Calcula (sin escribir) la nota diaria `01-Diario/<today>.md` con la línea añadida a
 * «Bucles abiertos». Si la nota no existe la crea desde la plantilla del vault.
 */
export async function planOpenLoop(
  vaultRoot: string,
  today: string,
  line: string,
): Promise<DailyUpdate> {
  const file = path.join(vaultRoot, '01-Diario', `${today}.md`);
  let current: string | null = null;
  try {
    current = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (current !== null) {
    return {
      file,
      created: false,
      text: setFrontmatterUpdated(insertOpenLoop(current, line), today),
    };
  }

  let template = SKELETON;
  try {
    template = await fs.readFile(
      path.join(vaultRoot, '99-Meta', 'Plantillas', 'Plantilla Diario.md'),
      'utf8',
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return {
    file,
    created: true,
    text: insertOpenLoop(template.replaceAll('YYYY-MM-DD', today), line),
  };
}
