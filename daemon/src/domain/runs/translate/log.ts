// A run's stream-json log reduced to what a person wants to read.
import { cut, oneLine } from '../../shared/index.ts';

/** An edit in numbers and a little text, for a small diff. */
export interface LogChange {
  added: number;
  removed: number;
  /** The old and new text, each cut at CHANGE_MAX characters. */
  old: string;
  new: string;
}

interface LogMeta {
  at?: string;
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
    | {
        kind: 'prompt';
        /** What claude was told, cut at PROMPT_MAX characters. */
        text: string;
        /** Lines in the whole text. */
        lines: number;
        /** Whether this claude continued a session cut off earlier. */
        resume: boolean;
        /** The retry's note the prompt carries; null when it carries none. */
        note: string | null;
      }
  );

export const CHANGE_MAX = 2048;
const OUTPUT_MAX = 4096;
const PROMPT_MAX = 65536;
const SUMMARY_MAX = 200;

export function costText(usd: number): string {
  if (!(usd > 0)) return '–';
  return usd < 0.01 ? '<$0.01 equiv' : `$${usd.toFixed(2)} equiv`;
}

const SYNC_TEXT: Record<string, string> = {
  clean: 'Synced the branch with the base branch: clean merge.',
  resolved: 'Synced the branch with the base branch: resolved the conflicts.',
  needs_resolution: 'The base branch conflicts with this branch, and auto-resolve is off: working on the branch as it is.',
  error: 'Could not sync with the base branch; working on the branch as it is.',
};

function toolFile(input: any): string | undefined {
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof file === 'string' && file ? file : undefined;
}

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

export function shortFile(summary: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const isFile = (typeof i.file_path === 'string' && i.file_path) || (typeof i.notebook_path === 'string' && i.notebook_path);
  return isFile ? summary.split('/').pop()! : summary;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

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
    case 'agentdeck_prompt': {
      const text = typeof ev.text === 'string' ? ev.text : '';
      const note = typeof ev.note === 'string' && ev.note.trim() ? ev.note.trim() : null;
      return [{ kind: 'prompt', text: text.slice(0, PROMPT_MAX), lines: countLines(text), resume: ev.resume === true, note }];
    }
    case 'agentdeck_pr':
      return [ev.error ? { kind: 'error', text: `pull request: ${ev.error}` } : { kind: 'text', text: `Opened pull request ${ev.url}` }];
    case 'agentdeck_sync':
      return SYNC_TEXT[ev.kind] ? [{ kind: 'text' as const, text: SYNC_TEXT[ev.kind] }] : [];
    case 'agentdeck_code_comments':
      return typeof ev.text === 'string' ? [{ kind: 'text', text: `Code comments: ${ev.text}` }] : [];
    case 'agentdeck_unblock':
      return typeof ev.text === 'string' ? [{ kind: 'text', text: ev.text }] : [];
    case 'agentdeck_protected_edits':
      return [
        ...(ev.applied?.length ? [{ kind: 'text' as const, text: `Applied protected edits: ${ev.applied.join(', ')}` }] : []),
        ...(ev.refused ?? []).map((r: any) => ({ kind: 'error' as const, text: `Refused protected edit ${r.path}: ${r.reason}` })),
      ];
    case 'agentdeck_stderr':
    case 'agentdeck_error':
      return [{ kind: 'error', text: String(ev.text).trim() }];
    default:
      return [];
  }
}
