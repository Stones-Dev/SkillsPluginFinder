export const WEEK_PATTERN = /^\d{4}-W\d{2}$/;

/** Fecha local (año, mes, día) de `now` en la zona horaria dada. */
function localDate(now: Date, timeZone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return [get('year'), get('month'), get('day')];
}

/**
 * Semana ISO 8601 (`YYYY-Www`, lunes a domingo, la semana 1 contiene el 4 de
 * enero) del día local en Europe/Madrid, sin dependencias.
 */
export function isoWeek(now: Date, timeZone = 'Europe/Madrid'): string {
  const [year, month, day] = localDate(now, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7; // lunes = 1 … domingo = 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday); // el jueves de esa semana
  const isoYear = date.getUTCFullYear();
  const dayOfYear =
    (date.getTime() - Date.UTC(isoYear, 0, 1)) / (24 * 60 * 60 * 1000);
  const week = Math.floor(dayOfYear / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function assertWeek(week: string): string {
  if (!WEEK_PATTERN.test(week)) {
    throw new Error(`Semana inválida: "${week}" (formato esperado YYYY-Www)`);
  }
  return week;
}

/** Fecha local `YYYY-MM-DD` en Europe/Madrid (la de las notas del vault). */
export function madridDate(now: Date): string {
  const [year, month, day] = localDate(now, 'Europe/Madrid');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
