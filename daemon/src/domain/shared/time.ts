// Times as the database and the API keep them: SQLite's `datetime('now')`, UTC "YYYY-MM-DD HH:MM:SS" with no zone marker.
// The one place that reads or writes that form. Pure: no I/O.

/** A SQLite stamp as milliseconds since the epoch; NaN for an unreadable one. */
export const sqliteMs = (stamp: string): number => Date.parse(`${stamp.replace(' ', 'T')}Z`);

/** An ISO 8601 date as the API's one time format, SQLite's UTC `YYYY-MM-DD HH:MM:SS`. */
export const sqliteUtc = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');

/** Minutes between two sqlite `datetime('now')` stamps (UTC, "YYYY-MM-DD HH:MM:SS"). 0 for an unreadable pair. */
export function minutesBetween(start: string, end: string): number {
  const ms = sqliteMs(end) - sqliteMs(start);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
}

/** The Monday (UTC) of the week a sqlite stamp falls in, as "YYYY-MM-DD". "" for an unreadable stamp. */
export function weekOf(stamp: string): string {
  const t = sqliteMs(stamp);
  if (!Number.isFinite(t)) return '';
  const day = new Date(t);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - sinceMonday)).toISOString().slice(0, 10);
}

/** The middle value (the mean of the two middle ones for an even count), or null for none. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
