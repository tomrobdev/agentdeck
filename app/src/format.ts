// How the dashboard words what the daemon reports: times, durations, holds and the daemon's state.
import type { Run, StartHold, Status } from './types.ts';

/** A hold in a few words, for chips and callouts. */
export function describeHold(h: StartHold): string {
  switch (h.kind) {
    case 'daemon-paused':
      return 'AgentDeck is paused';
    case 'rate-limited':
      return `Claude rate-limited us; resumes ${relTime(h.until)}`;
    case 'governor':
      return `Holding for the usage budget: ${h.reason}${h.until ? `; lifts around ${when(h.until)}` : ''}`;
    case 'repo-paused':
      return `The repo is paused: ${h.reason.split('\n')[0]}`;
    case 'dependency':
      return h.stuck ? `Waits for #${h.on}, which won't get there: ${h.stuck}` : `Waits for #${h.on} to finish`;
    case 'slots':
      return `Waiting for a free slot (${h.running} of ${h.max} in use)`;
  }
}

/** "Tue 14:00" style, for when a hold lifts. */
export function when(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** Every time from the daemon is SQLite's UTC `YYYY-MM-DD HH:MM:SS`, with no zone marker. */
export function parseTime(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

export function ago(time: string): string {
  const secs = Math.round((Date.now() - parseTime(time)) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** How long a run took, or has taken so far: "45s", "12m", "1.4h". */
export function runDuration(r: Run): string {
  const secs = ((r.ended_at ? parseTime(r.ended_at) : Date.now()) - parseTime(r.started_at)) / 1000;
  return secs < 90 ? `${Math.round(secs)}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
}

export function totalTokens(r: Run): number {
  return r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The banner text when the daemon runs a different commit than the dashboard, else null. Unknown commits never warn. */
export function describeStaleDaemon(s: Status | null, dashboardCommit: string | null): string | null {
  const d = s?.daemon;
  if (!d?.commit || !dashboardCommit || d.commit === dashboardCommit) return null;
  const started = new Date(d.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `The daemon is running older code (${d.commit.slice(0, 7)}, started ${started}). Restart it to match the dashboard.`;
}

/** One label for the daemon's state, shared by the status bar and the tray. */
export function describeState(s: Status | null, offline: boolean): { label: string; cls: string; title: string } {
  if (offline) return { label: 'Daemon offline', cls: 's-failed', title: '' };
  if (!s) return { label: 'Connecting…', cls: 's-queued', title: '' };
  if (s.paused) return { label: 'Paused', cls: 's-blocked', title: 'No new tasks start until you resume' };
  const limited = s.rate_limited_until && s.rate_limited_until * 1000 > Date.now() ? s.rate_limited_until : null;
  if (limited)
    return {
      label: `Rate limited · ${relTime(limited)}`,
      cls: 's-blocked',
      title: 'Claude rejected a request; waiting for the window to reset',
    };
  const g = s.governor;
  if (!g.allow)
    return { label: g.until ? `Holding · until ${when(g.until)}` : 'Holding', cls: 's-blocked', title: `Usage budget: ${g.reason}` };
  if (s.running) return { label: 'Working', cls: 's-running', title: g.reason ?? '' };
  return { label: 'Idle', cls: 's-done', title: g.reason ?? '' };
}
