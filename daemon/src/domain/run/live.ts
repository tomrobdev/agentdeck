// What a running task is doing right now, read from the events of its run's stream. Pure: no I/O.

import { toolSummary } from './log.ts';

/** What the daemon keeps of a live run: the turns so far and the last tool call in a few words. */
export interface LiveState {
  turns: number;
  /** The id of the last assistant message counted, so one message split over several events is one turn. */
  message: string | null;
  tool: string | null;
}

export const START_LIVE: LiveState = { turns: 0, message: null, tool: null };

/** The live state of a running task as the queue shows it. */
export interface LiveView {
  /** When the run started, as the database wrote it (UTC `YYYY-MM-DD HH:MM:SS`). */
  since: string;
  turns: number;
  max_turns: number;
  /** The last tool call in a few words, e.g. "Edit worker.ts"; null before the first one. */
  tool: string | null;
}

/** A running task's live view from its unfinished run's row; null for a task that is not running or has no run yet. */
export function liveView(
  task: { status: string; max_turns: number },
  run: { started_at: string; live_turns: number; live_tool: string | null } | undefined,
): LiveView | null {
  if (!run || (task.status !== 'running' && task.status !== 'cancel_requested')) return null;
  return { since: run.started_at, turns: run.live_turns, max_turns: task.max_turns, tool: run.live_tool };
}

/** A sync of a done task under way, as the queue shows it. */
export interface SyncView {
  /** The base branch being brought in, or "the base branch" when the repo is gone. */
  base: string;
  /** When the resolve run started (UTC `YYYY-MM-DD HH:MM:SS`); null for a clean sync, which runs no claude. */
  since: string | null;
  /** Whether a resolve run is settling conflicts. */
  resolving: boolean;
  turns: number;
  max_turns: number;
  /** The resolve run's last tool call in a few words; null before the first one or without a run. */
  tool: string | null;
}

/**
 * A done task's sync view: null when no sync is under way. `locked` is a sync holding the task's worktree in this process;
 * the unfinished resolve run, when there is one, says what claude is doing.
 */
export function syncView(
  task: { status: string; max_turns: number },
  base: string | null,
  locked: boolean,
  run: { started_at: string; live_turns: number; live_tool: string | null } | undefined,
): SyncView | null {
  if (task.status !== 'done' || (!locked && !run)) return null;
  const branch = base ?? 'the base branch';
  if (!run) return { base: branch, since: null, resolving: false, turns: 0, max_turns: task.max_turns, tool: null };
  return { base: branch, since: run.started_at, resolving: true, turns: run.live_turns, max_turns: task.max_turns, tool: run.live_tool };
}

const TOOL_TEXT_MAX = 40;

const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** A tool call in a few words: the tool, then the log's summary of the call, with a file shortened to its name. */
export function toolText(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const summary = toolSummary(name, input);
  const isFile = (typeof i.file_path === 'string' && i.file_path) || (typeof i.notebook_path === 'string' && i.notebook_path);
  const detail = isFile ? summary.split('/').pop()! : summary;
  return cut(detail ? `${name} ${detail}` : name, TOOL_TEXT_MAX);
}

/** The live state after one event of claude's stream: an assistant message is a turn, its last tool use is the tool. */
export function nextLive(state: LiveState, ev: any): LiveState {
  if (ev?.type !== 'assistant') return state;
  const id = typeof ev.message?.id === 'string' ? ev.message.id : null;
  const turns = id !== null && id === state.message ? state.turns : state.turns + 1;
  const uses = (Array.isArray(ev.message?.content) ? ev.message.content : []).filter((c: any) => c?.type === 'tool_use');
  const last = uses.at(-1);
  return { turns, message: id, tool: last ? toolText(String(last.name), last.input) : state.tool };
}
