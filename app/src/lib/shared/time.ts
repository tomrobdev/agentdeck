// How the dashboard words a moment or a length of time, whatever it is the time of.
import type { PrCheck, Run } from '#api/types.ts';
import { sqliteMs } from '#daemon/domain/shared/index.ts';

export function when(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

export function parseTime(s: string): number {
  return sqliteMs(s);
}

export function ago(time: string): string {
  const secs = Math.round((Date.now() - parseTime(time)) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function uptime(startedAt: string, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function runDuration(r: Run): string {
  const secs = ((r.ended_at ? parseTime(r.ended_at) : Date.now()) - parseTime(r.started_at)) / 1000;
  return secs < 90 ? `${Math.round(secs)}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
}

export function checkDuration(c: Pick<PrCheck, 'state' | 'started_at' | 'completed_at'>, now = Date.now()): string {
  if (!c.started_at) return '';
  const start = Date.parse(c.started_at);
  const end = c.completed_at ? Date.parse(c.completed_at) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const secs = Math.max(0, Math.round((end - start) / 1000));
  const text = secs < 90 ? `${secs}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
  return c.state === 'pending' ? `running for ${text}` : text;
}
