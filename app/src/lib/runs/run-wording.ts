// How the dashboard words a run: its name, what it did, what a running task or a sync under way is doing, and its tokens.
import type { LiveView, Run, SyncView } from '../../api/types.ts';
import { parseTime } from '../shared/time.ts';

export const MODEL_LABELS: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
export const MODEL_HINTS: Record<string, string> = { haiku: 'cheap, simple', sonnet: 'most tasks', opus: 'hard tasks' };

export function runLabel(r: Pick<Run, 'kind' | 'attempt'>): string {
  if (r.kind === 'resolve') return 'Resolve conflicts';
  if (r.kind === 'unblock') return 'Unblock run';
  if (r.kind === 'review') return 'Review';
  if (r.kind === 'verify') return 'Verify run';
  return `Run ${r.attempt}`;
}

export function runHint(r: Pick<Run, 'kind'>): string | undefined {
  if (r.kind === 'resolve') return 'Merged the base branch into the branch; uses no attempt';
  if (r.kind === 'unblock') return 'Read why the task blocked, then retried it with a note or asked you; uses no attempt';
  if (r.kind === 'review') return "Read the task's changes against its goal and plan steps, and left a review; uses no attempt";
  if (r.kind === 'verify') return "Checked each claim the task's prompt makes about the code against the base; uses no attempt";
  return undefined;
}

export function describeLive(l: LiveView): string {
  const secs = (Date.now() - parseTime(l.since)) / 1000;
  const took = secs < 90 ? `${Math.max(0, Math.round(secs))}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
  return [took, l.turns ? `turn ${l.turns}/${l.max_turns}` : null, l.tool].filter(Boolean).join(' · ');
}

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
