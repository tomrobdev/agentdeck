// The daemon's headline: what state it is in, and what needs a person.
import type { TaskId } from '#domain/shared/index.ts';
import type { PlanBranchConflict } from '#domain/work/index.ts';
import { type SupportRuns, slotsLine } from '#domain/capacity/index.ts';

export type HeadlineState = 'paused' | 'rate_limited' | 'hold' | 'working' | 'idle';
/** Why a task needs a person, in the order the attention list shows them. */
export type AttentionWhy = 'blocked' | 'review' | 'proposed';

export const ATTENTION_ORDER: AttentionWhy[] = ['blocked', 'review', 'proposed'];
export const ATTENTION_LIMIT = 5;

export interface AttentionTask {
  id: TaskId;
  title: string;
  why: AttentionWhy;
}

/** An attention candidate: a task that needs a person, with the priority it is ordered by. */
export interface AttentionCandidate extends AttentionTask {
  priority: number;
}

export interface HeadlineFacts {
  paused: boolean;
  /** Unix seconds; may have passed already. */
  rate_limited_until: number | null;
  /** The governor's decision: whether new work may start, and until when it waits if not. */
  governor: { allow: boolean; until: number | null };
  running: number;
  /** The work slots the governor allows, and the support runs under way beside them. */
  slots?: { max: number; support: SupportRuns };
  /** Proposed, blocked and in-review tasks. */
  need_you: { proposed: number; blocked: number; review: number };
  /** Tasks that need a person; any number, in any order. */
  attention: AttentionCandidate[];
  /** The repos due for an area review, as the daemon's last check found them. */
  review_due?: RepoReviewDue[];
  plan_branches?: PlanBranchConflict[];
}

/** A repo due for an area review, as the headline shows it. */
export interface RepoReviewDue {
  repo: string;
  /** "area review due: 9 days, 115 commits since the last" */
  line: string;
}

export interface Headline {
  state: HeadlineState;
  /** When a rate limit or a hold ends (unix seconds); null for any other state, or when it is not known. */
  until: number | null;
  /** "1/1 slots · 1 review": the work slots in use, then the support runs under way; null when not known. */
  slots: string | null;
  need_you: number;
  attention: AttentionTask[];
  review_due: RepoReviewDue[];
  plan_branches: PlanBranchConflict[];
}

export function attentionList(candidates: AttentionCandidate[]): AttentionTask[] {
  return [...candidates]
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.why) - ATTENTION_ORDER.indexOf(b.why) || b.priority - a.priority || a.id - b.id)
    .slice(0, ATTENTION_LIMIT)
    .map(({ id, title, why }) => ({ id, title, why }));
}

export function headline(facts: HeadlineFacts, now: number): Headline {
  const { proposed, blocked, review } = facts.need_you;
  const rest = {
    slots: facts.slots ? slotsLine(facts.running, facts.slots.max, facts.slots.support) : null,
    need_you: proposed + blocked + review,
    attention: attentionList(facts.attention),
    review_due: (facts.review_due ?? []).map(({ repo, line }) => ({ repo, line })),
    plan_branches: facts.plan_branches ?? [],
  };
  if (facts.paused) return { state: 'paused', until: null, ...rest };
  const limited = facts.rate_limited_until && facts.rate_limited_until > now ? facts.rate_limited_until : null;
  if (limited) return { state: 'rate_limited', until: limited, ...rest };
  if (!facts.governor.allow) return { state: 'hold', until: facts.governor.until || null, ...rest };
  return { state: facts.running ? 'working' : 'idle', until: null, ...rest };
}
