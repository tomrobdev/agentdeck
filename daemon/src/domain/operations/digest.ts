// The live state of a repo's queue in a few lines, for an agent: what changed since it last looked, and what is open.
import type { TaskId } from '#domain/shared/index.ts';
import { short } from '#domain/shared/index.ts';
import type { PrState } from '#domain/landing/index.ts';
import { type TaskEventRow, type TaskStatus, type Waiting, describeEvent, statusGroup } from '#domain/work/index.ts';

/** A history row with its task's title. */
export type DigestEvent = Pick<TaskEventRow, 'id' | 'task_id' | 'type' | 'from_status' | 'to_status' | 'reason'> & { title: string };

/** An open task as the digest shows it. */
export interface DigestTask {
  id: TaskId;
  title: string;
  status: TaskStatus;
  pr_state: PrState | null;
  stop_reason: string | null;
  waiting: Waiting | null;
  /** The auto-merge view's state and label (domain/landing/merge/auto-merge.ts); marked on the line unless it is off. */
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
  /** When a usage-limit backoff lifts (unix seconds), or null when none is in force. */
  rate_limited_until?: number | null;
  /** The repo's checkout: branch, short commit and subject. Null when git couldn't say. */
  head: { branch: string; commit: string; subject: string } | null;
  /** "area review due: 9 days, 115 commits since the last" when the repo is due for an area review; else null. */
  review_due?: string | null;
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

export const DIGEST_LIMIT = 12;
const EVENT_LINES = 6;

const MORE = (k: number) => `  +${k} more: agentdeck ls`;

const TITLE_MAX = 60;
const REASON_MAX = 80;

function describeTask(t: DigestTask): string {
  const status = t.status === 'done' && t.pr_state === 'open' ? 'in review' : t.status;
  let extra = '';
  if (t.waiting) {
    const on = t.waiting.on.map((id) => `#${id}`).join(', ');
    extra = t.waiting.stuck ? ` (stuck on ${on}: ${short(t.waiting.stuck, REASON_MAX)})` : ` (waiting on ${on})`;
  } else if ((t.status === 'blocked' || t.status === 'failed') && t.stop_reason) extra = ` — ${short(t.stop_reason, REASON_MAX)}`;
  if (t.auto_merge_view && t.auto_merge_view.state !== 'off') extra += ` [${short(t.auto_merge_view.label, REASON_MAX)}]`;
  return `${status} #${t.id} ${short(t.title, TITLE_MAX)}${extra}`;
}

const clock = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function headerLine(h: DigestHeader): string {
  const parts = [`AgentDeck live · ${h.repo}`, h.paused ? 'daemon PAUSED' : 'active'];
  if (h.repo_paused) parts.push(`repo PAUSED: ${short(h.repo_paused, REASON_MAX)}`);
  parts.push(`${h.running}/${h.max_concurrent} slots`);
  if (h.rate_limited_until) parts.push(`usage limit until ${clock(h.rate_limited_until)}`);
  parts.push(h.governor.allow ? 'governor allowing' : `governor on hold: ${short(h.governor.reason ?? '', REASON_MAX)}`);
  if (h.head) parts.push(`${h.head.branch} ${h.head.commit} ${short(h.head.subject, TITLE_MAX)}`);
  if (h.review_due) parts.push(h.review_due);
  return parts.join(' · ');
}

export function digest(input: DigestInput, limit = DIGEST_LIMIT): string[] {
  const body: string[] = [];
  if (input.events.length) {
    const byTask = new Map<number, { title: string; what: string[] }>();
    for (const e of input.events) {
      const entry = byTask.get(e.task_id) ?? { title: e.title, what: [] };
      entry.what.push(describeEvent(e, 'agent'));
      byTask.set(e.task_id, entry);
    }
    const lines = [...byTask].map(([id, { title, what }]) => `  #${id} ${short(title, TITLE_MAX)}: ${what.join(' · ')}`);
    body.push('Since your last message:');
    const room = EVENT_LINES - 1;
    if (lines.length <= room) body.push(...lines);
    else body.push(...lines.slice(0, room - 1), MORE(lines.length - (room - 1)));
  }
  if (input.events.length || input.full) {
    body.push(input.open.length ? 'Open:' : 'Open: nothing');
    const needsYou = (t: DigestTask) => ['needs-you', 'review', 'proposed'].includes(statusGroup(t));
    const open = [...input.open.filter(needsYou), ...input.open.filter((t) => !needsYou(t))];
    const room = Math.max(limit - body.length, 2);
    const shown = open.length <= room ? open : open.slice(0, room - 1);
    for (const t of shown) body.push(`  ${describeTask(t)}`);
    if (shown.length < open.length) body.push(MORE(open.length - shown.length));
  }
  return [headerLine(input.header), ...body];
}
