// What the Runs tab shows of a run as it goes: the live header and the timeline strip. Pure, so daemon/test tests them.
import { REVIEW_MAX_TURNS, UNBLOCK_MAX_TURNS, VERIFY_MAX_TURNS, isTestCommand } from '../../../../daemon/src/domain/runs/index.ts';
import { parseTime } from '../shared/time.ts';
import type { LogEntry, Run, TaskDetail } from '../../api/types.ts';
import { type Item, toolKind } from './transcript.ts';

export interface LiveSource {
  turns: number;
  max_turns: number;
  tool: string | null;
}

export function liveSource(run: Run, task: Pick<TaskDetail, 'live' | 'sync'>): LiveSource | null {
  if (run.kind === 'work') return task.live;
  if (run.kind === 'resolve') return task.sync?.resolving ? task.sync : null;
  const max_turns = run.kind === 'unblock' ? UNBLOCK_MAX_TURNS : run.kind === 'verify' ? VERIFY_MAX_TURNS : REVIEW_MAX_TURNS;
  return { turns: run.live_turns, max_turns, tool: run.live_tool };
}

export interface RunHeader {
  ended: boolean;
  outcome: Run['outcome'] | 'ended';
  turns: number;
  maxTurns: number | null;
  tool: string | null;
  toolSeconds: number | null;
  seconds: number;
}

function pendingCall(items: Item[]): { at?: string } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'plain') continue;
    if (item.type === 'explored') {
      const open = item.calls.findLast((c) => !c.result && c.call.id);
      if (open) return open.call;
      continue;
    }
    const inner = pendingCall(item.children);
    if (inner) return inner;
    if (!item.result && item.call.id) return item.call;
  }
  return null;
}

export function runHeader(run: Run, source: LiveSource | null, items: Item[], now: number): RunHeader {
  const start = parseTime(run.started_at);
  if (run.ended_at) {
    return {
      ended: true,
      outcome: run.outcome ?? 'ended',
      turns: run.num_turns ?? source?.turns ?? run.live_turns,
      maxTurns: source?.max_turns ?? null,
      tool: null,
      toolSeconds: null,
      seconds: Math.max(0, Math.round((parseTime(run.ended_at) - start) / 1000)),
    };
  }
  const tool = source?.tool ?? null;
  const at = tool ? pendingCall(items)?.at : undefined;
  return {
    ended: false,
    outcome: null,
    turns: source?.turns ?? run.live_turns,
    maxTurns: source?.max_turns ?? null,
    tool,
    toolSeconds: at ? Math.max(0, Math.round((now - Date.parse(at)) / 1000)) : null,
    seconds: Math.max(0, Math.round((now - start) / 1000)),
  };
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export type SegmentKind = 'read' | 'edit' | 'command' | 'test' | 'write';

export interface Segment {
  kind: SegmentKind;
  at: string;
  from: number;
  to: number | null;
  label: string;
}

export interface Tick {
  at: string | null;
  ms: number | null;
  label: string;
  failed: boolean;
}

function bashCommand(input: string): string {
  try {
    const v: unknown = JSON.parse(input);
    const c = v && typeof v === 'object' ? (v as Record<string, unknown>).command : undefined;
    return typeof c === 'string' ? c : '';
  } catch {
    return '';
  }
}

export function isTestCall(e: Extract<LogEntry, { kind: 'tool' }>, testCmd: string | null): boolean {
  return e.name === 'Bash' && isTestCommand(bashCommand(e.input), testCmd);
}

export function timeline(entries: LogEntry[], testCmd: string | null): { segments: Segment[]; ticks: Tick[] } {
  const segments: Segment[] = [];
  const ticks: Tick[] = [];
  const tests = new Map<string, { at: string; label: string }>();
  for (const e of entries) {
    if (e.parent) continue;
    if (e.kind === 'tests') {
      ticks.push({ at: null, ms: null, label: `Tests ${e.passed ? 'passed' : 'failed'}`, failed: !e.passed });
      continue;
    }
    if (!e.at || (e.kind !== 'text' && e.kind !== 'tool' && e.kind !== 'tool_result')) continue;
    const from = Date.parse(e.at);
    if (Number.isNaN(from)) continue;
    let kind: SegmentKind = 'write';
    let label = 'Claude writing';
    if (e.kind === 'tool') {
      const k = toolKind(e.name);
      kind = isTestCall(e, testCmd) ? 'test' : k === 'read' || k === 'edit' || k === 'command' ? k : 'write';
      label = `${e.name} ${e.summary}`.trim();
      if (kind === 'test' && e.id) tests.set(e.id, { at: e.at, label });
    } else if (e.kind === 'tool_result') {
      const t = tests.get(e.id);
      if (t && !e.ok) ticks.push({ at: t.at, ms: Date.parse(t.at), label: `${t.label} failed`, failed: true });
    }
    const last = segments.at(-1);
    if (last) last.to = from;
    segments.push({ kind, at: e.at, from, to: null, label });
  }
  ticks.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  return { segments, ticks };
}

export function stripShare(ms: number, start: number, end: number): number {
  return end > start ? Math.min(100, Math.max(0, (100 * (ms - start)) / (end - start))) : 0;
}

export function placeSegment(s: Segment, start: number, end: number): { left: number; width: number } {
  const left = stripShare(s.from, start, end);
  return { left, width: stripShare(s.to ?? end, start, end) - left };
}
