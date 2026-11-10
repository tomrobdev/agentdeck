// Times as the database and the API keep them: SQLite's `datetime('now')`, UTC "YYYY-MM-DD HH:MM:SS" with no zone marker.

export const sqliteMs = (stamp: string): number => Date.parse(`${stamp.replace(' ', 'T')}Z`);

export const sqliteUtc = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');

export function minutesBetween(start: string, end: string): number {
  const ms = sqliteMs(end) - sqliteMs(start);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
}

export function weekOf(stamp: string): string {
  const t = sqliteMs(stamp);
  if (!Number.isFinite(t)) return '';
  const day = new Date(t);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - sinceMonday)).toISOString().slice(0, 10);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
