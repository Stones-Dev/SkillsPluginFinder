import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CatalogEntry } from '../config/schema.js';
import { type Db, getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { madridDate } from '../pipeline/week.js';
import { parseCatalog } from '../vault/catalogo.js';
import { atomicWriteFile } from '../vault/fsutil.js';
import { editCatalogRow } from './catalog-edit.js';
import { removeDir } from './clone.js';
import { planOpenLoop } from './daily.js';
import { repoFromReviewId } from './list.js';
import {
  type ReviewJson,
  reviewDirFor,
  reviewJsonSchema,
  vaultRootOf,
} from './prepare.js';
import { type Signal, type SignalType, uniqueSignals } from './signals.js';

/** Estados que puede escribir una revisión (`candidato` no: de ahí se sale, no se vuelve). */
export const REVIEW_ESTADOS = ['probado', 'descartado', 'adoptado'] as const;
export type ReviewEstado = (typeof REVIEW_ESTADOS)[number];

export function parseReviewEstado(value: string): ReviewEstado {
  if (!(REVIEW_ESTADOS as readonly string[]).includes(value)) {
    throw new Error(
      `Estado no válido: "${value}" (válidos: ${REVIEW_ESTADOS.join(', ')})`,
    );
  }
  return value as ReviewEstado;
}

/** Marca que `cruzar-evaluaciones` deja en la nota del catálogo cuando los dos evaluadores discrepan. */
export const DISPUTA_MARK = '⚖ disputa';

export type ApplyOptions = {
  repoDir: string;
  vaultDir: string;
  /** `github:owner/repo`. */
  id: string;
  estado: ReviewEstado;
  nota: string;
  /** Señales que el agente ha visto al leer el clon; solo suman. */
  senales?: SignalType[];
  now?: Date;
  db?: Db;
};

export type ApplyResult = {
  id: string;
  requested: ReviewEstado;
  /** Lo que de verdad se escribió: `probado` si `adoptado` quedó bloqueado. */
  written: ReviewEstado;
  blocked: boolean;
  signals: Signal[];
  catalogFile: string;
  dailyFile: string | null;
  dailyCreated: boolean;
  row: CatalogEntry;
};

async function readReviewJson(
  repoDir: string,
  repo: string,
): Promise<ReviewJson | null> {
  const file = path.join(reviewDirFor(repoDir, repo), 'review.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = reviewJsonSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${file} no cumple el esquema: vuelve a ejecutar spf review --prepare.`,
    );
  }
  return parsed.data;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * `spf review --apply` (Plan §7 bis, Constitución §1 enmendada): escribe el
 * estado en `Catalogo.md` con una edición por línea. `adoptado` solo se escribe
 * si no hay ninguna señal de supply-chain (las del inventario y del enrich de
 * `review.json`, las que declare el agente y la marca de disputa de la nota); con
 * alguna, se escribe `probado`, se anota en «Bucles abiertos» de la nota diaria y
 * `blocked` es `true`. Falla cerrado: sin `review.json` no hay `adoptado`.
 */
export async function applyReview(opts: ApplyOptions): Promise<ApplyResult> {
  const { repoDir, vaultDir } = opts;
  const now = opts.now ?? new Date();
  const today = madridDate(now);
  const repo = repoFromReviewId(opts.id);
  const nota = oneLine(opts.nota);
  if (!nota) throw new Error('--nota no puede estar vacía: di por qué.');

  const catalogFile = path.join(vaultDir, 'Catalogo.md');
  const catalogText = await fs.readFile(catalogFile, 'utf8');
  const row = parseCatalog(catalogText).find((e) => e.repo === repo);
  if (!row) throw new Error(`${opts.id} no está en Catalogo.md.`);
  if (row.semana === 'baseline') {
    throw new Error(`${opts.id} es una fila del baseline: no se toca.`);
  }
  if (row.estado === 'adoptado' || row.estado === 'descartado') {
    throw new Error(
      `${opts.id} ya está ${row.estado}: lo decidió una persona o una revisión anterior y no se cambia desde aquí.`,
    );
  }

  const review = await readReviewJson(repoDir, repo);
  if (review && (review.id !== opts.id || review.semana !== row.semana)) {
    throw new Error(
      `review.json es de ${review.id} (${review.semana}) y no de ${opts.id} (${row.semana}): vuelve a ejecutar spf review --prepare.`,
    );
  }
  if (opts.estado === 'adoptado' && !review) {
    throw new Error(
      `No se puede adoptar ${opts.id} sin inventario: ejecuta antes spf review --prepare ${opts.id} (el inventario es lo que comprueba las señales de supply-chain).`,
    );
  }

  const signals = uniqueSignals([
    ...(review?.signals ?? []),
    ...(opts.senales ?? []).map(
      (tipo): Signal => ({
        tipo,
        detalle: 'declarada por el agente al leer el clon',
        fuente: 'agente',
      }),
    ),
    ...(row.nota.includes(DISPUTA_MARK)
      ? [
          {
            tipo: 'disputa' as const,
            detalle:
              'los dos evaluadores discrepan (marca en la nota del catálogo)',
            fuente: 'cruce' as const,
          },
        ]
      : []),
  ]);

  const blocked = opts.estado === 'adoptado' && signals.length > 0;
  const written: ReviewEstado = blocked ? 'probado' : opts.estado;
  const kinds = [...new Set(signals.map((s) => s.tipo))].join(', ');

  const verdict = blocked
    ? `${nota} · ⛔ adoptado bloqueado por la puerta de seguridad (${kinds})`
    : nota;
  const catalog = editCatalogRow(
    catalogText,
    repo,
    {
      estado: written,
      nota: `${row.nota} · Revisión ${today} (${written}): ${verdict}`,
    },
    today,
  );

  let daily: Awaited<ReturnType<typeof planOpenLoop>> | null = null;
  if (blocked) {
    const vaultRoot = await vaultRootOf(vaultDir);
    if (!vaultRoot) {
      throw new Error(
        'No encuentro la raíz del vault (dos niveles por encima de VAULT_PATH) para anotar el aviso en la nota diaria; no se escribe nada.',
      );
    }
    daily = await planOpenLoop(
      vaultRoot,
      today,
      `- [[SkillsPluginFinder]]: \`${opts.id}\` se queda en \`probado\` aunque la revisión automática pidió \`adoptado\`: señales de supply-chain (${kinds}). Decide a mano en [[Catalogo]].`,
    );
  }

  // Todo calculado y validado: ahora se escribe.
  await atomicWriteFile(catalogFile, catalog.text);
  if (daily) {
    await fs.mkdir(path.dirname(daily.file), { recursive: true });
    await atomicWriteFile(daily.file, daily.text);
  }

  const db = opts.db ?? getDb(path.join(repoDir, 'data', 'seen.sqlite'));
  await db.insert(runs).values({
    id: crypto.randomUUID(),
    half: 'review',
    week: row.semana,
    trigger: 'manual',
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    stats: {
      reviewed: 1,
      [written]: 1,
      blocked: blocked ? 1 : 0,
      signals: signals.length,
    },
    errorsBySource: [],
  });

  await removeDir(reviewDirFor(repoDir, repo));

  return {
    id: opts.id,
    requested: opts.estado,
    written,
    blocked,
    signals,
    catalogFile,
    dailyFile: daily?.file ?? null,
    dailyCreated: daily?.created ?? false,
    row: catalog.after,
  };
}

export function formatApply(r: ApplyResult): string[] {
  const lines = [
    r.blocked
      ? `⛔ ${r.id} → ${r.written} (se pidió ${r.requested}; bloqueado por la puerta de seguridad)`
      : `✓ ${r.id} → ${r.written}`,
  ];
  if (r.signals.length > 0) {
    lines.push('  señales de supply-chain:');
    for (const s of r.signals) {
      lines.push(`    - ${s.tipo} (${s.fuente}): ${s.detalle}`);
    }
  }
  lines.push(`  ${r.catalogFile}: fila actualizada`);
  if (r.dailyFile) {
    lines.push(
      `  ${r.dailyFile}: aviso en «Bucles abiertos»${r.dailyCreated ? ' (nota creada)' : ''}`,
    );
  }
  return lines;
}
