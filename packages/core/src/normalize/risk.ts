import type { Candidate } from './candidate.js';

/** Por debajo de estos días desde su creación, un repo se marca como joven. */
export const YOUNG_REPO_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RiskSignal = { level: 'info' | 'warn'; text: string };

/**
 * Señales de riesgo que se muestran siempre junto a cada hallazgo (Constitución
 * §6, HU-5): edad, actividad, contribuidores, scripts de instalación, licencia
 * y avisos del enriquecimiento. `warn` marca lo que conviene mirar antes de
 * instalar nada; `info` es contexto. Determinista: la actividad se mide contra
 * la fecha en que se encontró el candidato, no contra el reloj.
 */
export function riskSignals(c: Candidate): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const add = (level: RiskSignal['level'], text: string) =>
    signals.push({ level, text });

  const { risk } = c;
  if (risk.ageDays < YOUNG_REPO_DAYS) {
    add('warn', `Repo joven: creado hace ${risk.ageDays} días`);
  } else {
    add('info', `Creado hace ${risk.ageDays} días`);
  }

  const idleDays = Math.max(
    0,
    Math.floor((Date.parse(c.foundAt) - Date.parse(c.lastCommitAt)) / DAY_MS),
  );
  add('info', `Último push hace ${idleDays} días`);

  if (c.contributors === undefined) {
    add('info', 'Contribuidores: desconocido');
  } else if (risk.singleMaintainer) {
    add('warn', 'Un único contribuidor');
  } else {
    add('info', `${c.contributors} contribuidores`);
  }

  if (risk.postinstall === true) {
    add(
      'warn',
      `package.json ejecuta scripts al instalar: ${(risk.lifecycleScripts ?? []).join(', ')}`,
    );
  } else if (risk.postinstall === false) {
    add('info', 'Sin scripts de instalación en package.json');
  } else {
    add(
      'info',
      'package.json no comprobado (no hay uno en la raíz o falló la consulta)',
    );
  }

  if (!c.license || c.license.toUpperCase() === 'NOASSERTION') {
    add('warn', 'Licencia no reconocida');
  } else {
    add('info', `Licencia ${c.license}`);
  }

  for (const note of risk.notes) add('info', note);
  return signals;
}
