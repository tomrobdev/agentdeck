// The daemon's headline: what state it is in, and what needs a person. Decided once here, so the dashboard and the tray
// read it instead of each deciding. Pure: `now` is a parameter (unix seconds).
import type { TaskId } from '../shared/index.ts';

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
  /** Proposed, blocked and in-review tasks. */
  need_you: { proposed: number; blocked: number; review: number };
  /** Tasks that need a person; any number, in any order. */
  attention: AttentionCandidate[];
}

export interface Headline {
  state: HeadlineState;
  /** When a rate limit or a hold ends (unix seconds); null for any other state, or when it is not known. */
  until: number | null;
  need_you: number;
  attention: AttentionTask[];
}

/** The tasks to show first: blocked, then review, then proposed, each by priority (highest first) then id; at most five. */
export function attentionList(candidates: AttentionCandidate[]): AttentionTask[] {
  return [...candidates]
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.why) - ATTENTION_ORDER.indexOf(b.why) || b.priority - a.priority || a.id - b.id)
    .slice(0, ATTENTION_LIMIT)
    .map(({ id, title, why }) => ({ id, title, why }));
}

export function headline(facts: HeadlineFacts, now: number): Headline {
  const { proposed, blocked, review } = facts.need_you;
  const rest = { need_you: proposed + blocked + review, attention: attentionList(facts.attention) };
  if (facts.paused) return { state: 'paused', until: null, ...rest };
  const limited = facts.rate_limited_until && facts.rate_limited_until > now ? facts.rate_limited_until : null;
  if (limited) return { state: 'rate_limited', until: limited, ...rest };
  if (!facts.governor.allow) return { state: 'hold', until: facts.governor.until || null, ...rest };
  return { state: facts.running ? 'working' : 'idle', until: null, ...rest };
}
