// A run's log as a transcript: results paired with their calls, subagent entries nested, runs of reads folded.
import type { LogEntry } from '../../../daemon/src/api/contract.ts';

type Of<K extends LogEntry['kind']> = Extract<LogEntry, { kind: K }>;
export type ToolEntry = Of<'tool'>;
export type ResultEntry = Of<'tool_result'>;

/** A tool call with what came back (none yet, or none logged), and a subagent call's own entries beneath it. */
export interface CallItem {
  type: 'call';
  key: string;
  at?: string;
  call: ToolEntry;
  result: ResultEntry | null;
  children: Item[];
}
/** Back-to-back reads, searches and listings, folded into one line. */
export interface ExploredItem {
  type: 'explored';
  key: string;
  at?: string;
  calls: CallItem[];
}
export interface PlainItem {
  type: 'plain';
  key: string;
  at?: string;
  entry: Exclude<LogEntry, ToolEntry | ResultEntry>;
}
export type Item = CallItem | ExploredItem | PlainItem;

const EXPLORE = new Set(['Read', 'Grep', 'Glob', 'LS']);

function fold(items: Item[]): Item[] {
  const out: Item[] = [];
  let run: CallItem[] = [];
  const flush = () => {
    if (run.length > 1) out.push({ type: 'explored', key: `x${run[0].key}`, at: run[0].at, calls: run });
    else out.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.type === 'call' && EXPLORE.has(item.call.name) && !item.children.length) run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

/** Group a run's entries. A log from before results existed (no ids) comes out as one call item per call. */
export function buildTranscript(entries: LogEntry[]): Item[] {
  const results = new Map<string, ResultEntry>();
  const callIds = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'tool_result') results.set(e.id, e);
    else if (e.kind === 'tool' && e.id) callIds.add(e.id);
  }
  const roots: Item[] = [];
  const lists = new Map<string, Item[]>();
  entries.forEach((e, i) => {
    if (e.kind === 'tool_result') return;
    const list = (e.parent && lists.get(e.parent)) || roots;
    if (e.kind === 'tool') {
      const children: Item[] = [];
      if (e.id) lists.set(e.id, children);
      list.push({ type: 'call', key: String(i), at: e.at, call: e, result: (e.id && results.get(e.id)) || null, children });
    } else list.push({ type: 'plain', key: String(i), at: e.at, entry: e });
  });
  const foldAll = (items: Item[]): Item[] => {
    for (const it of items) if (it.type === 'call') it.children = foldAll(it.children);
    return fold(items);
  };
  return foldAll(roots);
}

/** Time since the run's first entry as m:ss (h:mm:ss past an hour); empty when either time is missing. */
export function offsetLabel(first: string | undefined, at: string | undefined): string {
  if (!first || !at) return '';
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(first)) / 1000));
  if (Number.isNaN(s)) return '';
  const sec = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}:${sec}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}`;
}

/** The first non-blank line of an output. */
export function firstLine(output: string): string {
  return output.split('\n').find((l) => l.trim()) ?? '';
}

/** A small diff of an Edit or Write: the old lines marked removed, then the new lines marked added. */
export function changeLines(change: NonNullable<ToolEntry['change']>): { sign: '+' | '−'; text: string }[] {
  const split = (t: string) => (t ? t.replace(/\n$/, '').split('\n') : []);
  return [
    ...split(change.old).map((text) => ({ sign: '−' as const, text })),
    ...split(change.new).map((text) => ({ sign: '+' as const, text })),
  ];
}

/** Whether the run's calls have all been answered: a call without a result is still going while the run is live. */
export function pending(item: CallItem, live: boolean): boolean {
  return live && !item.result && !!item.call.id;
}
