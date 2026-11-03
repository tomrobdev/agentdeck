// How the dashboard words what the daemon reports: times, durations, waits and the daemon's state.
import type {
  AutoMergeCheck,
  LiveView,
  NotifyKind,
  PrCheck,
  MergeRequestView,
  Run,
  StartWait,
  Status,
  SyncResult,
  SyncView,
} from './types.ts';
import { sqliteMs } from '../../../daemon/src/domain/time.ts';

/** What a queued task waits for, in a few words, for chips and callouts. */
export function describeWait(h: StartWait): string {
  switch (h.kind) {
    case 'daemon-paused':
      return 'AgentDeck is paused';
    case 'rate-limited':
      return `Claude rate-limited us; resumes ${relTime(h.until)}`;
    case 'governor':
      return `On hold for the usage budget: ${h.reason}${h.until ? `; lifts around ${when(h.until)}` : ''}`;
    case 'repo-paused':
      return `The repo is paused: ${h.reason.split('\n')[0]}`;
    case 'dependency':
      return h.stuck ? `Can't start: ${h.stuck}` : `Waits for ${h.on.map((id) => `#${id}`).join(', ')} to finish`;
    case 'slots':
      return `Waiting for a free slot (${h.running} of ${h.max} in use)`;
  }
}

/** What each notification kind is called in the settings. */
export const NOTIFY_LABELS: Record<NotifyKind, string> = {
  blocked: 'Task blocked',
  failed: 'Task failed',
  done: 'Task done',
  hold: 'Work held by budget',
  paused: 'Repo paused',
  proposed: 'Planner proposals',
  merged: 'PR auto-merged',
  checks_failed: 'PR checks failed',
};

/** What each model is called, and when to pick it. */
export const MODEL_LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
export const MODEL_HINTS: Record<string, string> = { haiku: 'cheap, simple', sonnet: 'default', opus: 'hard tasks' };

/** Whether the daemon will merge a PR on its own, in a line. */
export function autoMergeLine(c: AutoMergeCheck): string {
  if (c.verdict === 'merge') return 'on; merges on the next PR refresh';
  return `${c.verdict === 'wait' ? 'on; waiting: ' : 'needs you: '}${c.reasons.join('; ')}`;
}

/** A task's merge request on its row: "Merging when ready · 2 checks running", or "Merging…". */
export function describeMergeRequest(r: MergeRequestView): string {
  if (r.state === 'merging') return 'Merging…';
  return ['Merging when ready', ...r.reasons].join(' · ');
}

/** What a sync of a task's branch came to, in a sentence. Where the push went is the caller's to add. */
export function syncLine(r: Pick<SyncResult, 'outcome' | 'files' | 'reason'>): string {
  switch (r.outcome) {
    case 'resolved':
      return `Resolved conflicts in ${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}.`;
    case 'clean':
      return 'Synced with the base branch.';
    case 'up_to_date':
      return 'The branch is already up to date.';
    case 'blocked':
      return `Blocked: ${r.reason ?? 'the conflicts could not be settled'}`;
    default:
      return r.reason ?? r.outcome;
  }
}

/** "Tue 14:00" style, for when a wait ends. */
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
  return sqliteMs(s);
}

export function ago(time: string): string {
  const secs = Math.round((Date.now() - parseTime(time)) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** How long the daemon has run, from its ISO start time: "45s", "12m", "3h 5m", "2d 4h". */
export function uptime(startedAt: string, now = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "#80", "#80 and #81", "#80, #81 and #82". */
export function taskList(ids: number[]): string {
  const tags = ids.map((id) => `#${id}`);
  return tags.length < 2 ? tags.join('') : `${tags.slice(0, -1).join(', ')} and ${tags[tags.length - 1]}`;
}

/** A run's name: "Run 2", or the kind of run that uses no attempt. */
export function runLabel(r: Pick<Run, 'kind' | 'attempt'>): string {
  return r.kind === 'resolve' ? 'Resolve conflicts' : r.kind === 'unblock' ? 'Unblock run' : `Run ${r.attempt}`;
}

/** What a run that uses no attempt did, for a tooltip; undefined for a work run. */
export function runHint(r: Pick<Run, 'kind'>): string | undefined {
  if (r.kind === 'resolve') return 'Merged the base branch into the branch; uses no attempt';
  if (r.kind === 'unblock') return 'Read why the task blocked, then retried it with a note or asked you; uses no attempt';
  return undefined;
}

/** How long a run took, or has taken so far: "45s", "12m", "1.4h". */
export function runDuration(r: Run): string {
  const secs = ((r.ended_at ? parseTime(r.ended_at) : Date.now()) - parseTime(r.started_at)) / 1000;
  return secs < 90 ? `${Math.round(secs)}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
}

/** How long a PR check took, or has run so far ("running for 2m"); empty when GitHub gave no start time. */
export function checkDuration(c: Pick<PrCheck, 'state' | 'started_at' | 'completed_at'>, now = Date.now()): string {
  if (!c.started_at) return '';
  const start = Date.parse(c.started_at);
  const end = c.completed_at ? Date.parse(c.completed_at) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  const secs = Math.max(0, Math.round((end - start) / 1000));
  const text = secs < 90 ? `${secs}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
  return c.state === 'pending' ? `running for ${text}` : text;
}

/** A running task's state on its row: "12m · turn 14/40 · Edit worker.ts" (the turn and tool once there are any). */
export function describeLive(l: LiveView): string {
  const secs = (Date.now() - parseTime(l.since)) / 1000;
  const took = secs < 90 ? `${Math.max(0, Math.round(secs))}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
  return [took, l.turns ? `turn ${l.turns}/${l.max_turns}` : null, l.tool].filter(Boolean).join(' · ');
}

/** A task in review whose sync is under way, on its row: "Syncing with main…", or "Resolving conflicts · 3m · turn 4/40 · Edit a.ts". */
export function describeSync(s: SyncView): string {
  if (!s.resolving || !s.since) return `Syncing with ${s.base}…`;
  return `Resolving conflicts · ${describeLive({ since: s.since, turns: s.turns, max_turns: s.max_turns, tool: s.tool })}`;
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
    return { label: g.until ? `On hold · until ${when(g.until)}` : 'On hold', cls: 's-blocked', title: `Usage budget: ${g.reason}` };
  if (s.running) return { label: 'Working', cls: 's-running', title: g.reason ?? '' };
  return { label: 'Idle', cls: 's-done', title: g.reason ?? '' };
}
