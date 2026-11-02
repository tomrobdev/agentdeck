// A run's stream-json log reduced to what a person wants to read. Pure: no I/O.

/** An edit in numbers and a little text, for a small diff. */
export interface LogChange {
  added: number;
  removed: number;
  /** The old and new text, each cut at CHANGE_MAX characters. */
  old: string;
  new: string;
}

/** What every entry from a claude event may carry besides its own fields. */
interface LogMeta {
  /** The event's timestamp. */
  at?: string;
  /** The `tool_use` id of the subagent call this entry comes from. */
  parent?: string;
}

export type LogEntry = LogMeta &
  (
    | { kind: 'text'; text: string }
    | {
        kind: 'tool';
        id?: string; // the tool_use id
        name: string;
        input: string;
        summary: string; // the call in a line
        file?: string; // the path the tool reads or writes, uncut
        change?: LogChange;
      }
    | { kind: 'tool_result'; id: string; ok: boolean; output: string; lines: number }
    | { kind: 'result'; subtype: string; turns: number; cost: number }
    | { kind: 'setup'; passed: boolean; cmd: string; output: string }
    | { kind: 'tests'; passed: boolean; output: string }
    | { kind: 'error'; text: string }
  );

const CHANGE_MAX = 2048;
const OUTPUT_MAX = 4096;
const SUMMARY_MAX = 200;

/** What the daemon's `agentdeck_sync` event (bringing the base branch in before a run) says in the log. */
const SYNC_TEXT: Record<string, string> = {
  clean: 'Brought the base branch into the branch: clean merge.',
  resolved: 'Resolved conflicts with the base branch.',
  needs_resolution: 'The base branch conflicts with this branch, and auto-resolve is off: working on the branch as it is.',
  error: 'Could not bring in the base branch; working on the branch as it is.',
};

/** The file a tool call names (Read, Edit, Write: file_path; Glob, Grep: path; NotebookEdit: notebook_path). */
function toolFile(input: any): string | undefined {
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof file === 'string' && file ? file : undefined;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The call in a line, by tool; what the log and the live line both say. Empty when the input has nothing to say. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? oneLine(v) : '');
  let text = '';
  switch (name) {
    case 'Bash':
      text = str(i.command);
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      text = str(i.file_path) || str(i.notebook_path);
      break;
    case 'Grep': {
      const pattern = str(i.pattern);
      const where = str(i.path);
      text = pattern && where ? `${pattern} in ${where}` : pattern || where;
      break;
    }
    case 'Glob':
      text = str(i.pattern);
      break;
    case 'WebFetch':
      text = str(i.url);
      break;
    case 'Task':
    case 'Agent':
      text = str(i.description);
      break;
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : null;
      if (todos) text = `${todos.length} todos, ${todos.filter((t: any) => t?.status === 'completed').length} done`;
      break;
    }
  }
  if (!text) text = Object.values(i).map(str).find(Boolean) ?? '';
  return cut(text, SUMMARY_MAX);
}

/** A text cut to `max` characters, ending in an ellipsis when it was longer. */
export function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A call's summary with the file it names shortened to the file's name; unchanged for a call that names no file. */
export function shortFile(summary: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const isFile = (typeof i.file_path === 'string' && i.file_path) || (typeof i.notebook_path === 'string' && i.notebook_path);
  return isFile ? summary.split('/').pop()! : summary;
}

/** Lines in a text: none for an empty one, and a trailing newline starts no line. */
function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** What an Edit, MultiEdit or Write changes; undefined for any other tool or an input that does not say. */
function toolChange(name: string, input: any): LogChange | undefined {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  let pairs: [string, string][];
  if (name === 'Edit') pairs = [[text(input?.old_string), text(input?.new_string)]];
  else if (name === 'MultiEdit' && Array.isArray(input?.edits))
    pairs = input.edits.map((e: any) => [text(e?.old_string), text(e?.new_string)]);
  else if (name === 'Write') pairs = [['', text(input?.content)]];
  else return undefined;
  const old = pairs.map((p) => p[0]).join('\n');
  const next = pairs.map((p) => p[1]).join('\n');
  return {
    added: pairs.reduce((n, p) => n + countLines(p[1]), 0),
    removed: pairs.reduce((n, p) => n + countLines(p[0]), 0),
    old: old.slice(0, CHANGE_MAX),
    new: next.slice(0, CHANGE_MAX),
  };
}

/** A tool result's content as text: a string as it is, a list of blocks with its text joined and each image written `[image]`. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'image' ? '[image]' : typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function parseLogLine(line: string): LogEntry[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? [{ kind: 'error', text: line }] : [];
  }
  const entries = parseEvent(ev);
  if (ev.type !== 'assistant' && ev.type !== 'user' && ev.type !== 'result') return entries;
  const meta: LogMeta = {
    ...(typeof ev.timestamp === 'string' && ev.timestamp ? { at: ev.timestamp } : {}),
    ...(typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id ? { parent: ev.parent_tool_use_id } : {}),
  };
  return entries.map((e) => ({ ...e, ...meta }));
}

function parseEvent(ev: any): LogEntry[] {
  switch (ev.type) {
    case 'assistant':
      return (ev.message?.content ?? []).flatMap((c: any): LogEntry[] => {
        if (c.type === 'text' && c.text.trim()) return [{ kind: 'text', text: c.text.trim() }];
        if (c.type === 'tool_use') {
          const file = toolFile(c.input);
          const change = toolChange(c.name, c.input);
          return [
            {
              kind: 'tool',
              ...(typeof c.id === 'string' ? { id: c.id } : {}),
              name: c.name,
              input: JSON.stringify(c.input).slice(0, 400),
              summary: toolSummary(c.name, c.input),
              ...(file ? { file } : {}),
              ...(change ? { change } : {}),
            },
          ];
        }
        return [];
      });
    case 'user':
      return (Array.isArray(ev.message?.content) ? ev.message.content : []).flatMap((c: any): LogEntry[] => {
        if (c?.type !== 'tool_result') return [];
        const output = resultText(c.content);
        return [
          {
            kind: 'tool_result',
            id: String(c.tool_use_id ?? ''),
            ok: !c.is_error,
            output: output.slice(0, OUTPUT_MAX),
            lines: countLines(output),
          },
        ];
      });
    case 'result':
      return [{ kind: 'result', subtype: ev.subtype, turns: ev.num_turns ?? 0, cost: ev.total_cost_usd ?? 0 }];
    case 'agentdeck_setup':
      return [{ kind: 'setup', passed: ev.passed, cmd: ev.cmd, output: ev.output }];
    case 'agentdeck_tests':
      return [{ kind: 'tests', passed: ev.passed, output: ev.output }];
    case 'agentdeck_pr':
      return [ev.error ? { kind: 'error', text: `pull request: ${ev.error}` } : { kind: 'text', text: `Opened pull request ${ev.url}` }];
    case 'agentdeck_sync':
      return SYNC_TEXT[ev.kind] ? [{ kind: 'text' as const, text: SYNC_TEXT[ev.kind] }] : [];
    case 'agentdeck_stderr':
    case 'agentdeck_error':
      return [{ kind: 'error', text: String(ev.text).trim() }];
    default:
      return [];
  }
}
