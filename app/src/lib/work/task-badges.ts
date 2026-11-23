// What every view of a task shows besides its title: the list row, the board card, the peek and the task page header.
import type { TaskSummary } from '#daemon/api/contract/work.ts';
import type { AutoMergeView } from '#daemon/api/contract/landing.ts';
import { isReview, isWaitingToLand, planLandingText } from '#daemon/domain/work/index.ts';
import { plural } from '#daemon/domain/shared/index.ts';
import { describeMergeRequest } from '#lib/landing/landing-wording.ts';
import { describeLive, describeSync } from '#lib/runs/run-wording.ts';
import { describeWait } from '#lib/work/work-wording.ts';
import type { Tone as ChipTone } from '#lib/shared/tone.ts';
import { needsOf, questionOf } from '#lib/shared/wire.ts';

export type Tone = 'muted' | 'accent' | 'done' | 'blocked' | 'failed';

export interface StatusLine {
  kind: 'live' | 'sync' | 'merge_request' | 'stopped' | 'cant_start' | 'auto_merge';
  text: string;
  tone: Tone;
  title: string;
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
  up: number[];
  down: number[];
  facts: Fact[];
}

export interface BadgeOptions {
  repo?: boolean;
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
  | 'plan_landing'
  | 'merges_into'
  | 'checks'
  | 'needs'
  | 'question'
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
  if (t.wait?.kind === 'draining') return line('cant_start', describeWait(t.wait), 'muted');
  if (t.wait?.kind === 'slots' && t.wait.repo) return line('cant_start', describeWait(t.wait), 'muted');
  const am = t.auto_merge_view;
  if (am && isReview(t)) {
    const title = [am.label, ...am.reasons].join('\n');
    if (am.state === 'merge') return line('auto_merge', 'Auto-merges on the next PR refresh', 'done', { title });
    if (am.state === 'wait') return line('auto_merge', ['Auto-merges when ready', ...am.reasons].join(' · '), 'muted', { title });
  }
  return null;
}

export function taskBadges(t: Viewed, opts: BadgeOptions = {}): Badges {
  const attention: AttentionChip[] = [];
  const needs = t.status === 'blocked' ? needsOf(t.needs) : null;
  if (needs) attention.push({ label: `needs ${needs.kind}`, title: `The worker asked for: ${needs.items.join(' ')}`, tone: 'blocked' });
  if (t.status === 'blocked' && questionOf(t.question))
    attention.push({ label: 'asks you', title: 'An unblock run left a question for you on the task page', tone: 'blocked' });
  const am = t.auto_merge_view;
  if (t.conflicting && t.pr_state === 'open')
    attention.push({ label: 'conflicts', title: 'The PR conflicts with the base branch: sync the task to settle it', tone: 'failed' });
  else if (am?.state === 'never' && !t.merge_request)
    attention.push({ label: "won't auto-merge", title: [am.label, ...am.reasons].join('\n'), tone: 'failed' });
  if (am?.code_comments)
    attention.push({ label: am.code_comments, title: "Over the repo's code comment limits: a person needs to merge it", tone: 'blocked' });
  const checks = t.pr_state === 'open' ? t.checks : null;
  if (checks && checks.total > 0 && checks.failing > 0) {
    const n = checks.failing;
    const running = checks.pending ? `; ${checks.pending} still running` : '';
    attention.push({
      label: `✗ ${plural(n, 'check')} failing`,
      title: checks.failing_lines.some((line, i) => line !== checks.failing_names[i])
        ? `Failing${running}:\n${checks.failing_lines.join('\n')}`
        : `Failing: ${checks.failing_names.join(', ')}${running}`,
      tone: 'failed',
    });
  }
  const notRun = checks?.not_run ?? [];
  if (notRun.length) attention.push({ label: 'CI did not run', title: `CI did not run: ${notRun.join('; ')}`, tone: 'blocked' });
  if (t.plan_unfinished) attention.push({ label: 'steps unfinished', title: 'The run left linked plan steps unfinished', tone: 'blocked' });

  const up = t.links.filter((l) => l.kind === 'builds_on' && l.state !== 'met').map((l) => l.on);

  const facts: Fact[] = [];
  if (t.merges_into?.plan && !t.plan_landing)
    facts.push({
      label: `→ ${t.merges_into.branch}`,
      title: `Merges into ${t.merges_into.branch}, which lands on ${t.merges_into.plan.base}`,
    });
  if (t.attempts > 1) facts.push({ label: `try ${t.attempts}`, title: `Attempt ${t.attempts} of ${t.max_attempts}` });
  if (t.source === 'planner') facts.push({ label: 'planner', title: 'Proposed by the planner' });
  if (checks && checks.total > 0 && checks.failing === 0 && !notRun.length) {
    if (checks.pending)
      facts.push({
        label: `● checks ${checks.total - checks.pending}/${checks.total}`,
        title: `${checks.pending} of ${checks.total} checks still running`,
      });
    else facts.push({ label: '✓ checks', title: `All ${checks.total} checks passed` });
  }
  if (t.plan_landing) {
    const text = planLandingText(t.plan_landing);
    facts.push({ label: text, title: `The pull request merged into the plan branch ${t.plan_landing.name}: ${text}` });
  } else if (opts.pr !== false && (t.pr_state === 'merged' || t.pr_state === 'closed'))
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

  return { attention, up, down: t.unblocks, facts };
}

export const statusText = (t: Pick<TaskSummary, 'status' | 'pr_state'> & Partial<Pick<TaskSummary, 'plan_landing'>>): string =>
  isReview(t) ? 'in review' : isWaitingToLand(t) ? 'waiting to land' : t.status === 'cancel_requested' ? 'stopping' : t.status;

export function fixReason(t: Pick<TaskSummary, 'status' | 'pr_state' | 'stop_reason' | 'auto_merge_view'>): string {
  const am = isReview(t) ? t.auto_merge_view : null;
  const parts = [
    `It is ${statusText(t)}.`,
    t.status === 'blocked' || t.status === 'failed' ? t.stop_reason : null,
    am?.label,
    ...(am?.reasons ?? []),
  ];
  return parts.filter((p): p is string => !!p).join(' ');
}

export const TONE_TEXT: Record<Tone, string> = {
  muted: 'text-muted',
  accent: 'text-accent',
  done: 'text-done',
  blocked: 'text-blocked',
  failed: 'text-failed',
};

export const AUTO_MERGE_CHIP: Record<AutoMergeView['state'], ChipTone> = {
  off: 'muted',
  on: 'muted',
  merge: 'done',
  wait: 'blocked',
  never: 'failed',
};

export const TONE_CHIP: Record<AttentionChip['tone'], ChipTone> = { blocked: 'blocked', failed: 'failed' };
