// What a running task is doing right now, read from the events of its run's stream. Pure: no I/O.

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

const TOOL_TEXT_MAX = 40;

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** A tool call in a few words: the tool, then the file's name, the command or the pattern it works on. */
export function toolText(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? squash(v) : '');
  const file = str(i.file_path) || str(i.notebook_path);
  const detail = file ? file.split('/').pop()! : str(i.command) || str(i.pattern) || str(i.path) || str(i.description) || str(i.url);
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
