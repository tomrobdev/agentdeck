// A run's log as a transcript: results paired with their calls, subagent entries nested, runs of reads folded.
import type { LogEntry } from '../../../../daemon/src/api/contract/files.ts';

type Of<K extends LogEntry['kind']> = Extract<LogEntry, { kind: K }>;
export type ToolEntry = Of<'tool'>;
export type ResultEntry = Of<'tool_result'>;

export interface CallItem {
  type: 'call';
  key: string;
  at?: string;
  call: ToolEntry;
  result: ResultEntry | null;
  children: Item[];
}
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
const READ_KIND = new Set([...EXPLORE, 'WebFetch']);
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export type ToolKind = 'read' | 'edit' | 'command' | 'agent' | 'other';

export function toolKind(name: string): ToolKind {
  if (READ_KIND.has(name)) return 'read';
  if (WRITES.has(name)) return 'edit';
  if (name === 'Bash') return 'command';
  if (name === 'Task' || name === 'Agent') return 'agent';
  return 'other';
}

export const TOOL_ICONS: Record<ToolKind, string> = { read: '◉', edit: '✎', command: '$', agent: '◆', other: '●' };

export function fold(items: Item[]): Item[] {
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

export function offsetLabel(first: string | undefined, at: string | undefined): string {
  if (!first || !at) return '';
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(first)) / 1000));
  if (Number.isNaN(s)) return '';
  const sec = String(s % 60).padStart(2, '0');
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}:${sec}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${sec}`;
}

export function firstLine(output: string): string {
  return output.split('\n').find((l) => l.trim()) ?? '';
}

export function resultHidden(item: CallItem): boolean {
  return !!item.result?.ok && WRITES.has(item.call.name);
}

export function cutRoot(root: string | null | undefined): (text: string) => string {
  const prefix = root ? root.replace(/\/$/, '') + '/' : '';
  return (text) => (prefix ? text.split(prefix).join('') : text);
}

function inputOf(input: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readRange(item: CallItem): string | null {
  if (item.call.name !== 'Read' || !item.result?.ok) return null;
  const n = item.result.lines;
  const input = inputOf(item.call.input);
  const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : 1;
  if (input.limit === undefined && n === 2000) return 'first 2000 lines';
  return `lines ${offset}–${offset + n - 1}`;
}

export interface OutputPart {
  text: string;
  path?: string;
  line?: number | null;
  conflict?: boolean;
}

const CONFLICT = /^(<{7}|={7}|>{7})/;

export function outputParts(output: string, opts: { grep?: string; file?: string | null; isPath?: (p: string) => boolean }): OutputPart[] {
  const ok = (p: string) => !!opts.isPath?.(p);
  const norm = (p: string) => p.replace(/^\.\//, '');
  const grep = opts.grep !== undefined;
  const mode = grep ? inputOf(opts.grep!).output_mode : undefined;
  const bare = grep && (mode === undefined || mode === 'files_with_matches');
  const lines = output.split('\n');
  const parts: OutputPart[] = [];
  lines.forEach((text, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (CONFLICT.test(text)) return void parts.push({ text: text + nl, conflict: true });
    if (grep) {
      const m = /^(.+?):(\d+):/.exec(text);
      if (m && ok(norm(m[1]))) {
        const head = `${m[1]}:${m[2]}:`;
        parts.push({ text: head, path: norm(m[1]), line: Number(m[2]) }, { text: text.slice(head.length) + nl });
        return;
      }
      const single = /^(\d+):/.exec(text);
      if (single && opts.file && ok(norm(opts.file))) {
        const head = `${single[1]}:`;
        parts.push({ text: head, path: norm(opts.file), line: Number(single[1]) }, { text: text.slice(head.length) + nl });
        return;
      }
      if (bare && text.trim() && ok(norm(text.trim()))) return void parts.push({ text, path: norm(text.trim()), line: null }, { text: nl });
    }
    parts.push({ text: text + nl });
  });
  return parts;
}

export function pending(item: CallItem, live: boolean): boolean {
  return live && !item.result && !!item.call.id;
}
