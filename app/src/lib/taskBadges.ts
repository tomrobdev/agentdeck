// What every view of a task shows besides its title: the list row, the board card, the peek and the task page header.
// Four kinds of thing, each shown one way:
// - the status line: at most one sentence, in a tone, never a chip;
// - attention: coloured chips, only where a person must act;
// - links: ↑ the builds-on dependencies not yet met, ↓ the tasks merging this one releases;
// - facts: muted text, joined by " · ".
// Free of the dashboard's other modules so the daemon's tests can import it (daemon/test/task-badges.test.ts). What the
// daemon decides (needs, a conflict, auto-merge, merge requests) comes from the API; this only picks and words it.
import type { AutoMergeView, TaskSummary } from '../../../daemon/src/api/contract.ts';
import { readNeeds } from '../../../daemon/src/domain/task/needs.ts';
import { isReview } from '../../../daemon/src/domain/task/stage.ts';
import { describeLive, describeMergeRequest, describeSync, describeWait } from '../api/format.ts';
import type { Tone as ChipTone } from './tone.ts';

export type Tone = 'muted' | 'accent' | 'done' | 'blocked' | 'failed';

export interface StatusLine {
  /** What it is about, so a view can leave some out (the list's "reason" display option hides `stopped` and `cant_start`). */
  kind: 'live' | 'sync' | 'merge_request' | 'stopped' | 'cant_start' | 'auto_merge';
  text: string;
  tone: Tone;
  /** The longer form, for a tooltip; the text itself when there is none. */
  title: string;
  /** A merge request waits: it can be withdrawn from the line. */
  cancelMerge: boolean;
}

export interface AttentionChip {
  label: string;
  title: string;
  tone: 'blocked' | 'failed';
}

export interface Fact {
  label: string;
  title: string;
}

export interface Badges {
  attention: AttentionChip[];
  /** Builds-on dependencies not met yet: the task starts once they are done and merged. */
  up: number[];
  /** Queued tasks that merging this one lets start. */
  down: number[];
  facts: Fact[];
}

export interface BadgeOptions {
  /** Show the repo (the display option). */
  repo?: boolean;
  /** Show a merged or closed PR (the display option); on unless turned off. */
  pr?: boolean;
}

type Viewed = Pick<
  TaskSummary,
  | 'status'
  | 'stop_reason'
  | 'repo'
  | 'attempts'
  | 'max_attempts'
  | 'source'
  | 'pr_state'
  | 'checks'
  | 'needs'
  | 'auto_merge_view'
  | 'merge_request'
  | 'conflicting'
  | 'waiting'
  | 'unblocks'
  | 'links'
  | 'plan_unfinished'
  | 'live'
  | 'sync'
  | 'wait'
>;

const line = (kind: StatusLine['kind'], text: string, tone: Tone, more: Partial<StatusLine> = {}): StatusLine => ({
  kind,
  text,
  tone,
  title: text,
  cancelMerge: false,
  ...more,
});

/** The one sentence about where a task stands, the first that applies; null when there is nothing to say. */
export function statusLine(t: Viewed): StatusLine | null {
  if (t.live) return line('live', describeLive(t.live), 'muted');
  if (t.sync) return line('sync', describeSync(t.sync), 'accent');
  if (t.merge_request)
    return line('merge_request', describeMergeRequest(t.merge_request), 'accent', { cancelMerge: t.merge_request.state === 'waiting' });
  if ((t.status === 'blocked' || t.status === 'failed') && t.stop_reason) return line('stopped', t.stop_reason, t.status);
  if (t.waiting?.stuck) return line('cant_start', `Can't start: ${t.waiting.stuck}`, 'blocked');
  if (t.wait?.kind === 'repo-paused')
    return line('cant_start', `Can't start: ${t.repo ?? 'the repo'} is paused`, 'blocked', { title: describeWait(t.wait) });
  if (t.wait?.kind === 'daemon-paused') return line('cant_start', `Can't start: ${describeWait(t.wait)}`, 'blocked');
  const am = t.auto_merge_view;
  if (am && isReview(t)) {
    const title = [am.label, ...am.reasons].join('\n');
    if (am.state === 'merge') return line('auto_merge', 'Auto-merges on the next PR refresh', 'done', { title });
    if (am.state === 'wait') return line('auto_merge', ['Auto-merges when ready', ...am.reasons].join(' · '), 'muted', { title });
  }
  return null;
}

/** A task's attention chips, links and facts. */
export function taskBadges(t: Viewed, opts: BadgeOptions = {}): Badges {
  const attention: AttentionChip[] = [];
  const needs = t.status === 'blocked' ? readNeeds(t.needs ?? null) : null;
  if (needs) attention.push({ label: `needs ${needs.kind}`, title: `The worker asked for: ${needs.items.join(' ')}`, tone: 'blocked' });
  const am = t.auto_merge_view;
  if (t.conflicting && t.pr_state === 'open')
    attention.push({ label: 'conflicts', title: 'The PR conflicts with the base branch: sync the task to settle it', tone: 'failed' });
  else if (am?.state === 'never' && !t.merge_request)
    attention.push({ label: "won't auto-merge", title: [am.label, ...am.reasons].join('\n'), tone: 'failed' });
  const checks = t.pr_state === 'open' ? t.checks : null;
  if (checks && checks.total > 0 && checks.failing > 0) {
    const n = checks.failing;
    const running = checks.pending ? `; ${checks.pending} still running` : '';
    attention.push({
      label: `✗ ${n} ${n === 1 ? 'check' : 'checks'} failing`,
      title: `Failing: ${checks.failing_names.join(', ')}${running}`,
      tone: 'failed',
    });
  }
  if (t.plan_unfinished) attention.push({ label: 'steps unfinished', title: 'The run left linked plan steps unfinished', tone: 'blocked' });

  // A daemon from before links existed only says what a queued task waits on.
  const up = t.links ? t.links.filter((l) => l.kind === 'builds_on' && l.state !== 'met').map((l) => l.on) : (t.waiting?.on ?? []);

  const facts: Fact[] = [];
  if (t.attempts > 1) facts.push({ label: `try ${t.attempts}`, title: `Attempt ${t.attempts} of ${t.max_attempts}` });
  if (t.source === 'planner') facts.push({ label: 'planner', title: 'Proposed by the planner' });
  if (checks && checks.total > 0 && checks.failing === 0) {
    if (checks.pending)
      facts.push({
        label: `● checks ${checks.total - checks.pending}/${checks.total}`,
        title: `${checks.pending} of ${checks.total} checks still running`,
      });
    else facts.push({ label: '✓ checks', title: `All ${checks.total} checks passed` });
  }
  if (opts.pr !== false && (t.pr_state === 'merged' || t.pr_state === 'closed'))
    facts.push({ label: `PR ${t.pr_state}`, title: `The pull request is ${t.pr_state}` });
  if (am?.source === 'task') {
    const on = am.state !== 'off';
    facts.push({
      label: `auto-merge ${on ? 'on' : 'off'}`,
      title: [`Auto-merge is ${on ? 'on' : 'off'} for this task, whatever the repo says`, ...(on ? [am.label, ...am.reasons] : [])].join(
        '\n',
      ),
    });
  }
  if (opts.repo && t.repo) facts.push({ label: t.repo, title: `Repo ${t.repo}` });

  return { attention, up, down: t.unblocks ?? [], facts };
}

/** The word on a task's status pill: a done task whose PR is open is in review; a cancel under way is stopping. */
export const statusText = (t: Pick<TaskSummary, 'status' | 'pr_state'>): string =>
  isReview(t) ? 'in review' : t.status === 'cancel_requested' ? 'stopping' : t.status;

/** The text colour for each tone. */
export const TONE_TEXT: Record<Tone, string> = {
  muted: 'text-muted',
  accent: 'text-accent',
  done: 'text-done',
  blocked: 'text-blocked',
  failed: 'text-failed',
};

/** The chip tone for each auto-merge state: green will merge, amber waits, red needs a person, grey is on and unchecked. */
export const AUTO_MERGE_CHIP: Record<AutoMergeView['state'], ChipTone> = {
  off: 'muted',
  on: 'muted',
  merge: 'done',
  wait: 'blocked',
  never: 'failed',
};

/** The chip tone for each attention tone. */
export const TONE_CHIP: Record<AttentionChip['tone'], ChipTone> = { blocked: 'blocked', failed: 'failed' };
