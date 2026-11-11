// How a task's history rows are worded, for an agent (terse, in the digest) and for a person (the timeline).
import { type TaskEventRow, isAutoMergeReason, isPrOpenedReason, isRequestedMergeReason, prSeenState } from '../lifecycle/history.ts';
import { short } from '../../shared/index.ts';

type EventFields = Pick<TaskEventRow, 'type' | 'to_status' | 'reason'>;

/** What the timeline shows for a row: the sentence, and the reason to show muted beside it. */
export interface PersonEventText {
  text: string;
  reason?: string;
}

const REASON_MAX = 80;

const withReason = (what: string, reason: string | null) => (reason ? `${what}: ${short(reason, REASON_MAX)}` : what);

function agentText(e: EventFields): string {
  if (e.to_status === 'cancelled' && e.type !== 'reject') return 'cancelled';
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
    case 'unblock_retry':
      return 'unblock run: retried with a note';
    case 'review_retry':
      return 'review run: requested changes';
    case 'unblock_ask':
      return 'unblock run: asked a question';
    case 'mark_done':
      return 'marked done by a person';
    case 'pr_merged':
      return 'PR merged';
    case 'merge':
      if (e.reason && isAutoMergeReason(e.reason)) return `PR ${short(e.reason, REASON_MAX)}`;
      if (e.reason && isRequestedMergeReason(e.reason)) return `PR merged as ${short(e.reason, REASON_MAX)}`;
      return e.reason ? `PR merged (${short(e.reason, REASON_MAX)})` : 'PR merged';
    case 'pr': {
      if (isPrOpenedReason(e.reason)) return 'PR opened';
      const seen = prSeenState(e.reason);
      if (seen !== null) return `PR ${short(seen, REASON_MAX)}`;
      return withReason('PR', e.reason);
    }
    case 'pr_closed':
      return 'PR closed without merging';
    case 'edit':
      return withReason('edited', e.reason);
    case 'sync':
      return 'synced with the base branch';
    case 'plan_unfinished':
      return 'left plan steps unfinished';
    case 'environment_block':
      return withReason('blocked by the environment', e.reason);
    case 'escalate':
      return withReason('model moved up', e.reason);
    default:
      return e.type;
  }
}

const REASON_IN_TEXT = new Set<string>(['sync', 'pr', 'pr_closed', 'plan_unfinished', 'pr_merged']);

function personText(e: EventFields): PersonEventText | null {
  const reason = e.reason ?? undefined;
  const say = (text: string): PersonEventText => ({ text, ...(reason && !REASON_IN_TEXT.has(e.type) ? { reason } : {}) });
  switch (e.type) {
    case 'approve':
      return say('approved the proposal');
    case 'reject':
      return say('rejected the proposal');
    case 'retry':
      return say(e.reason ? 'requested changes' : 'queued another attempt');
    case 'cancel':
      return say(e.to_status === 'cancel_requested' ? 'asked the run to stop' : 'cancelled the task');
    case 'edit':
      return say(e.reason ? `edited the task (${e.reason})` : 'edited the task');
    case 'merge':
      if (isAutoMergeReason(e.reason)) return say('auto-merged the pull request');
      if (isRequestedMergeReason(e.reason)) return say('merged the pull request as requested');
      return say('merged the pull request');
    case 'mark_done':
      return say('marked done by hand');
    case 'pr_merged':
      return say('PR merged on GitHub');
    case 'pr': {
      if (!e.reason) return say('pull request changed');
      const seen = prSeenState(e.reason);
      if (seen !== null) return say(`pull request ${seen}`);
      return say(`pull request ${e.reason}`);
    }
    case 'pr_closed':
      return say('pull request closed without merging');
    case 'sync':
      return say(e.reason ?? 'synced with the base branch');
    case 'plan_unfinished':
      return say(e.reason ?? 'left linked plan steps unfinished');
    case 'environment_block':
      return say('blocked by the environment; attempt given back');
    case 'escalate':
      return say('moved the next attempt to a stronger model');
    case 'conflict':
      return say("the sync hit conflicts it couldn't settle; blocked");
    case 'rate_limited':
      return say('hit the usage limit; back in the queue without using an attempt');
    case 'recover':
      return say(e.to_status === 'failed' ? 'failed after repeated daemon restarts' : 'requeued after a daemon restart');
    case 'created':
    case 'unblock_ask':
    case 'claim':
    case 'finish':
    case 'unblock_retry':
    case 'review_retry':
      return null;
  }
}

export function describeEvent(e: EventFields, reader?: 'agent'): string;
export function describeEvent(e: EventFields, reader: 'person'): PersonEventText | null;
export function describeEvent(e: EventFields, reader: 'agent' | 'person' = 'agent'): string | PersonEventText | null {
  return reader === 'person' ? personText(e) : agentText(e);
}
