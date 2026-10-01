import { z } from 'zod';

/**
 * Señales de supply-chain que bloquean `adoptado` (Constitución §1, enmendada el
 * 2026-10-01). `disputa` y `sin-enrich` no están en la Constitución: la primera
 * la decidió Stones el 2026-10-01 (desacuerdo entre los dos evaluadores) y la
 * segunda es el cierre «en falso»: sin datos del enrich no se puede descartar
 * que el repo sea joven y de un solo mantenedor.
 */
export const SIGNAL_TYPES = [
  'install-script',
  'registro-propio',
  'mcp-remoto',
  'repo-joven-un-mantenedor',
  'privilegios',
  'disputa',
  'sin-enrich',
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export const signalSchema = z
  .object({
    tipo: z.enum(SIGNAL_TYPES),
    /** Qué se vio y dónde (fichero o dato). */
    detalle: z.string().min(1),
    /** `inventario`, `enrich`, `cruce` o `agente`. */
    fuente: z.enum(['inventario', 'enrich', 'cruce', 'agente']),
  })
  .strict();

export type Signal = z.infer<typeof signalSchema>;

/** Misma señal (tipo y detalle) una sola vez; el orden de llegada se conserva. */
export function uniqueSignals(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((s) => {
    const key = `${s.tipo}\u0000${s.detalle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseSignalType(value: string): SignalType {
  if (!(SIGNAL_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `Señal desconocida: "${value}" (válidas: ${SIGNAL_TYPES.join(', ')})`,
    );
  }
  return value as SignalType;
}
