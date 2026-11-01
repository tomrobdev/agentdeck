// The live state of a repo's queue in a few lines, for an agent: what changed since it last looked, and what is open.
// Pure: the caller reads the events, tasks and header facts. `agentdeck context` prints it, and Claude Code's hooks run that.
import type { TaskEventRow } from './history.ts';
import type { TaskStatus } from './lifecycle.ts';

/** A history row with its task's title. */
export type DigestEvent = Pick<TaskEventRow, 'id' | 'task_id' | 'type' | 'from_status' | 'to_status' | 'reason'> & { title: string };

/** An open task as the digest shows it. */
export interface DigestTask {
  id: number;
  title: string;
  status: TaskStatus;
  pr_state: string | null;
  stop_reason: string | null;
  waiting: { on: number; stuck: string | null } | null;
  /** The auto-merge view's state and label (domain/pull-request/auto-merge.ts); marked on the line unless it is off. */
  auto_merge_view?: { state: string; label: string } | null;
}

export interface DigestHeader {
  repo: string;
  /** The daemon is paused. */
  paused: boolean;
  /** Why the repo is paused, or null. */
  repo_paused: string | null;
  running: number;
  max_concurrent: number;
  governor: { allow: boolean; reason: string | null };
  /** The repo's checkout: branch, short commit and subject. Null when git couldn't say. */
  head: { branch: string; commit: string; subject: string } | null;
}

export interface DigestInput {
  header: DigestHeader;
  /** Events since the reader last looked, oldest first. */
  events: DigestEvent[];
  /** Open tasks, in the order to show them. */
  open: DigestTask[];
  /** Show the open tasks even when nothing changed (a session's start). */
  full: boolean;
}

/** Lines below the header at most; the rest is counted in a last line. */
export const DIGEST_LIMIT = 12;

const TITLE_MAX = 60;
const REASON_MAX = 80;

/** The first line of a text, cut to `max` characters. */
function short(text: string, max: number): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const withReason = (what: string, reason: string | null) => (reason ? `${what}: ${short(reason, REASON_MAX)}` : what);

/** What one history row says happened, in the domain language. */
export function describeEvent(e: Pick<TaskEventRow, 'type' | 'to_status' | 'reason'>): string {
  switch (e.type) {
    case 'created':
      return e.to_status === 'proposed' ? 'proposed' : 'added';
    case 'claim':
      return 'started';
    case 'finish':
      if (e.to_status === 'queued') return withReason('failed, queued to retry', e.reason);
      if (e.to_status === 'blocked' || e.to_status === 'failed') return withReason(e.to_status, e.reason);
      return e.to_status ?? 'finished';
    case 'rate_limited':
      return 'queued again: usage limit';
    case 'recover':
      return e.to_status === 'queued' ? 'queued again after a daemon restart' : withReason('failed after daemon restarts', e.reason);
    case 'conflict':
      return withReason('blocked: conflict', e.reason);
    case 'cancel':
      return e.to_status === 'cancel_requested' ? 'cancel requested' : 'cancelled';
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'retry':
      return withReason('retried', e.reason);
    case 'mark_done':
      return 'marked done by a person';
    case 'pr_merged':
      return 'PR merged';
    case 'merge':
      // The reason is how: "auto-merged (squash)" from the daemon, "squash merge" from a person.
      if (e.reason?.startsWith('auto-merged')) return `PR ${short(e.reason, REASON_MAX)}`;
      return e.reason ? `PR merged (${short(e.reason, REASON_MAX)})` : 'PR merged';
    case 'pr':
      return e.reason?.startsWith('opened ') ? 'PR opened' : withReason('PR', e.reason);
    case 'edit':
      return withReason('edited', e.reason);
    case 'sync':
      return 'synced with the base branch';
    case 'plan_unfinished':
      return 'left plan steps unfinished';
    case 'environment_block':
      return withReason('blocked by the environment', e.reason);
    default:
      return e.type;
  }
}

/** One open task: its status, title, and why it waits or stopped. */
function describeTask(t: DigestTask): string {
  const status = t.status === 'done' && t.pr_state === 'open' ? 'in review' : t.status;
  let extra = '';
  if (t.waiting)
    extra = t.waiting.stuck ? ` (stuck on #${t.waiting.on}: ${short(t.waiting.stuck, REASON_MAX)})` : ` (waiting on #${t.waiting.on})`;
  else if ((t.status === 'blocked' || t.status === 'failed') && t.stop_reason) extra = ` — ${short(t.stop_reason, REASON_MAX)}`;
  if (t.auto_merge_view && t.auto_merge_view.state !== 'off') extra += ` [${short(t.auto_merge_view.label, REASON_MAX)}]`;
  return `${status} #${t.id} ${short(t.title, TITLE_MAX)}${extra}`;
}

function headerLine(h: DigestHeader): string {
  const parts = [`AgentDeck live · ${h.repo}`, h.paused ? 'daemon PAUSED' : 'active'];
  if (h.repo_paused) parts.push(`repo PAUSED: ${short(h.repo_paused, REASON_MAX)}`);
  parts.push(`${h.running}/${h.max_concurrent} slots`);
  parts.push(h.governor.allow ? 'governor allowing' : `governor holding: ${short(h.governor.reason ?? '', REASON_MAX)}`);
  if (h.head) parts.push(`${h.head.branch} ${h.head.commit} ${short(h.head.subject, TITLE_MAX)}`);
  return parts.join(' · ');
}

/**
 * The header, then what changed since the reader last looked (grouped by task, oldest first), then the open tasks.
 * With no changes and `full` unset it is the header alone, so a quiet turn costs one line.
 */
export function digest(input: DigestInput, limit = DIGEST_LIMIT): string[] {
  const body: string[] = [];
  if (input.events.length) {
    const byTask = new Map<number, { title: string; what: string[] }>();
    for (const e of input.events) {
      const entry = byTask.get(e.task_id) ?? { title: e.title, what: [] };
      entry.what.push(describeEvent(e));
      byTask.set(e.task_id, entry);
    }
    body.push('Since your last message:');
    for (const [id, { title, what }] of byTask) body.push(`  #${id} ${short(title, TITLE_MAX)}: ${what.join(' · ')}`);
  }
  if (input.events.length || input.full) {
    body.push(input.open.length ? 'Open:' : 'Open: nothing');
    for (const t of input.open) body.push(`  ${describeTask(t)}`);
  }
  if (body.length > limit) {
    const cut = body.length - (limit - 1);
    body.splice(limit - 1, cut, `  +${cut} more: agentdeck ls`);
  }
  return [headerLine(input.header), ...body];
}
