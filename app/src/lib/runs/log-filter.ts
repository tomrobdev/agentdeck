// The run log's filter, its failures and how long each call took. Pure, so the dashboard's rules are tested from daemon/test.
import { clock, isTestCall } from '#lib/runs/run-live.ts';
import { type CallItem, type Item, fold, toolKind } from '#lib/runs/transcript.ts';

export type LogFilter = 'all' | 'text' | 'edits' | 'commands' | 'failures';

export const LOG_FILTERS: { value: LogFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Every entry' },
  { value: 'text', label: 'Text', title: "Claude's text" },
  { value: 'edits', label: 'Edits', title: 'Edit, MultiEdit and Write calls' },
  { value: 'commands', label: 'Commands', title: 'Bash calls, the daemon’s setup and test runs, and calls that failed' },
  { value: 'failures', label: 'Failures', title: 'Failed test calls, failed setup and test runs, and errors' },
];

export const SLOW_MS = 60_000;

export function parseLogFilter(v: unknown): LogFilter {
  return LOG_FILTERS.some((f) => f.value === v) ? (v as LogFilter) : 'all';
}

export function isFailure(item: Item, testCmd: string | null): boolean {
  if (item.type === 'call') return !!item.result && !item.result.ok && isTestCall(item.call, testCmd);
  if (item.type !== 'plain') return false;
  const e = item.entry;
  return e.kind === 'error' || ((e.kind === 'setup' || e.kind === 'tests') && !e.passed);
}

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

export function callDuration(item: CallItem): number | null {
  const from = item.at ? Date.parse(item.at) : NaN;
  const to = item.result?.at ? Date.parse(item.result.at) : NaN;
  return Number.isNaN(from) || Number.isNaN(to) ? null : Math.max(0, to - from);
}

export function durationLabel(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : clock(Math.round(ms / 1000));
}

export function isSlow(ms: number | null): boolean {
  return ms !== null && ms > SLOW_MS;
}

export function failureStep(tops: number[], dir: 1 | -1, slack = 10): number {
  if (dir === 1) return tops.findIndex((t) => t > slack);
  for (let i = tops.length - 1; i >= 0; i--) if (tops[i] < -slack) return i;
  return -1;
}
