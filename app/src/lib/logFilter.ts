// The run log's filter, its failures and how long each call took. Pure, so the dashboard's rules are tested from daemon/test.
import { clock, isTestCall } from './runLive.ts';
import { type CallItem, type Item, fold, toolKind } from './transcript.ts';

export type LogFilter = 'all' | 'text' | 'edits' | 'commands' | 'failures';

export const LOG_FILTERS: { value: LogFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Every entry' },
  { value: 'text', label: 'Text', title: "Claude's text" },
  { value: 'edits', label: 'Edits', title: 'Edit, MultiEdit and Write calls' },
  { value: 'commands', label: 'Commands', title: 'Bash calls, the daemon’s setup and test runs, and calls that failed' },
  { value: 'failures', label: 'Failures', title: 'Failed test calls, failed setup and test runs, and errors' },
];

/** A call that is over this long is marked slow. */
export const SLOW_MS = 60_000;

/** A stored filter, or All when it is not one of the five. */
export function parseLogFilter(v: unknown): LogFilter {
  return LOG_FILTERS.some((f) => f.value === v) ? (v as LogFilter) : 'all';
}

/** Whether an item is a failure: a failed test call, a failed setup or test run by the daemon, or an error entry. */
export function isFailure(item: Item, testCmd: string | null): boolean {
  if (item.type === 'call') return !!item.result && !item.result.ok && isTestCall(item.call, testCmd);
  if (item.type !== 'plain') return false;
  const e = item.entry;
  return e.kind === 'error' || ((e.kind === 'setup' || e.kind === 'tests') && !e.passed);
}

/** Whether an item itself (not what is nested under it) belongs under a filter. */
function matches(item: Item, filter: LogFilter, testCmd: string | null): boolean {
  if (filter === 'failures') return isFailure(item, testCmd);
  if (item.type === 'plain') {
    const k = item.entry.kind;
    if (filter === 'text') return k === 'text';
    return filter === 'commands' && (k === 'setup' || k === 'tests');
  }
  if (item.type !== 'call') return false;
  const kind = toolKind(item.call.name);
  if (filter === 'edits') return kind === 'edit';
  if (filter === 'commands') return kind === 'command' || (kind !== 'edit' && !!item.result && !item.result.ok);
  return false;
}

function flatten(items: Item[]): Item[] {
  return items.flatMap((i) => (i.type === 'explored' ? i.calls : [i]));
}

/**
 * The items a filter leaves. It runs before the Explored folding: reads are unfolded, filtered and folded again. A subagent's
 * call stays, with only its matching steps, when any step matches.
 */
export function filterItems(items: Item[], filter: LogFilter, testCmd: string | null): Item[] {
  if (filter === 'all') return items;
  const keep = (list: Item[]): Item[] => {
    const out: Item[] = [];
    for (const item of flatten(list)) {
      if (item.type === 'call') {
        const children = keep(item.children);
        if (matches(item, filter, testCmd) || children.length) out.push({ ...item, children });
      } else if (matches(item, filter, testCmd)) out.push(item);
    }
    return fold(out);
  };
  return keep(items);
}

/** The keys of every failure in a transcript, nested ones included. */
export function failureKeys(items: Item[], testCmd: string | null): Set<string> {
  const keys = new Set<string>();
  const walk = (list: Item[]) => {
    for (const item of list) {
      if (item.type === 'explored') walk(item.calls);
      else {
        if (isFailure(item, testCmd)) keys.add(item.key);
        if (item.type === 'call') walk(item.children);
      }
    }
  };
  walk(items);
  return keys;
}

/** How long a call took, in ms, from its time to its result's; null without a result or a time on either. */
export function callDuration(item: CallItem): number | null {
  const from = item.at ? Date.parse(item.at) : NaN;
  const to = item.result?.at ? Date.parse(item.result.at) : NaN;
  return Number.isNaN(from) || Number.isNaN(to) ? null : Math.max(0, to - from);
}

/** A duration as "0.4s", "12s" or "1m 05s". */
export function durationLabel(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : clock(Math.round(ms / 1000));
}

export function isSlow(ms: number | null): boolean {
  return ms !== null && ms > SLOW_MS;
}

/** The index of the failure after (`dir` 1) or before (-1) the reader's place, from the rows' offsets to the log's top; -1 when none. */
export function failureStep(tops: number[], dir: 1 | -1, slack = 10): number {
  if (dir === 1) return tops.findIndex((t) => t > slack);
  for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < -slack) return i;
  return -1;
}
