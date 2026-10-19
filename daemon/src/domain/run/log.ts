// A run's stream-json log reduced to what a person wants to read. Pure: no I/O.

export type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string; file?: string } // file: the path the tool reads or writes, uncut
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string };

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

export function parseLogLine(line: string): LogEntry[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? [{ kind: 'error', text: line }] : [];
  }
  switch (ev.type) {
    case 'assistant':
      return (ev.message?.content ?? []).flatMap((c: any): LogEntry[] => {
        if (c.type === 'text' && c.text.trim()) return [{ kind: 'text', text: c.text.trim() }];
        if (c.type === 'tool_use') {
          const file = toolFile(c.input);
          return [{ kind: 'tool', name: c.name, input: JSON.stringify(c.input).slice(0, 400), ...(file ? { file } : {}) }];
        }
        return [];
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
