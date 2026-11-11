// A finished run's claude stream summed up for a person: how it spent its turns and time, how its tests went, and what it was doing when it stopped.
import { cut, plural } from '../../shared/index.ts';

/** How the run's claude ended: out of turns, on its own, on another error, or cut off before a result. */
export type RunEnd = 'max_turns' | 'ended' | 'error' | 'cut_off';

export interface RunSummary {
  end: RunEnd;
  /** The main loop's turns: its assistant messages, one per message id. */
  turns: number;
  /** The turn limit the run had, from claude's error, else the task's; null when neither says. */
  max_turns: number | null;
  /** Minutes overall (claude's own duration, else the span of the stream's timestamps) and in test commands, to a tenth. */
  minutes: number;
  test_minutes: number;
  /** The main loop's tool calls by tool, the most used first. */
  tools: { name: string; count: number }[];
  /** How many times it ran a test command, in how many turns, and how the last one went. */
  test_runs: number;
  test_turns: number;
  last_test: 'passed' | 'failed' | null;
  /** Tool calls refused by the run's permissions. */
  refused: number;
  /** The tail of the last failing output it saw: a failing test run's, else any failed tool call's. */
  excerpt: string | null;
  /** Its final message: the result's text, else the main loop's last text. */
  final_message: string | null;
  /** The last measurement of the code comments the branch adds, such as "12 code comment lines added (8%), over the limit of 5 lines or 5%"; null when not measured. */
  code_comments: string | null;
  /** The summary in one line, such as "used 60 of 60 turns, 14 of them running tests that kept failing". */
  verdict: string;
}

export interface SummaryContext {
  /** The repo's test command; a common test runner counts as a test run too. */
  testCmd: string | null;
  /** The task's turn limit, for a stream whose result does not name its own. */
  maxTurns: number | null;
}

const EXCERPT_LINES = 12;
const EXCERPT_MAX = 1200;
const FINAL_MAX = 2000;

const TEST_RUNNERS = [
  /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b/,
  /\bnode\s+(?:--\S+\s+)*--test\b/,
  /\b(?:pytest|vitest|jest)\b/,
  /\b(?:cargo|go)\s+test\b/,
];

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function isTestCommand(command: string, testCmd: string | null): boolean {
  const cmd = squash(command);
  const repoCmd = testCmd ? squash(testCmd) : '';
  return (repoCmd !== '' && cmd.includes(repoCmd)) || TEST_RUNNERS.some((r) => r.test(cmd));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

function tail(output: string): string {
  const plain = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s+$/, '');
  const lines = plain.split('\n').slice(-EXCERPT_LINES).join('\n');
  return lines.length > EXCERPT_MAX ? `…${lines.slice(-EXCERPT_MAX)}` : lines;
}

const ms = (at: unknown): number | null => {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? null : t;
};

const tenths = (millis: number): number => Math.round(millis / 6000) / 10;

function limitFrom(errors: unknown): number | null {
  for (const e of Array.isArray(errors) ? errors : []) {
    const m = typeof e === 'string' ? /maximum number of turns \((\d+)\)/i.exec(e) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

function testsText(runs: number, last: 'passed' | 'failed' | null): string {
  if (!runs) return 'no test runs';
  const word = last === 'passed' ? 'passing' : 'failing';
  return runs === 1 ? `1 test run, ${word}` : `${runs} test runs, the last ${word}`;
}

function verdictOf(s: Omit<RunSummary, 'verdict'>, failStreak: number, subtype: string): string {
  const refused = s.refused ? `, ${plural(s.refused, 'tool call')} refused` : '';
  const tests = testsText(s.test_runs, s.last_test);
  if (s.end === 'max_turns') {
    const used = s.max_turns === null ? `used ${s.turns} turns` : `used ${s.turns} of ${s.max_turns} turns`;
    if (failStreak >= 2) return `${used}, ${s.test_turns} of them running tests that kept failing${refused}`;
    return `${used} mid-work: ${tests}${refused}`;
  }
  const after = `after ${plural(s.turns, 'turn')}`;
  const how = s.end === 'ended' ? `ended ${after}` : s.end === 'error' ? `stopped by ${subtype} ${after}` : `cut off ${after}`;
  return `${how}: ${tests}${refused}`;
}

export function runSummary(events: unknown[], ctx: SummaryContext): RunSummary {
  let turns = 0;
  let message: string | null = null;
  let lastText: string | null = null;
  let result: any = null;
  let deniedEvents = 0;
  let first: number | null = null;
  let last: number | null = null;
  const tools = new Map<string, number>();
  const pending = new Map<string, { at: number | null; turn: number }>();
  const testTurnSet = new Set<number>();
  let testRuns = 0;
  let testMs = 0;
  let lastTest: 'passed' | 'failed' | null = null;
  let failStreak = 0;
  let testFailure: string | null = null;
  let anyFailure: string | null = null;
  let codeComments: string | null = null;

  for (const raw of events) {
    const ev = raw as any;
    if (!ev || typeof ev !== 'object') continue;
    const at = ms(ev.timestamp);
    if (at !== null) {
      first ??= at;
      last = at;
    }
    if (ev.type === 'agentdeck_code_comments' && typeof ev.text === 'string') codeComments = ev.text;
    if (ev.type === 'result') result = ev;
    else if (ev.type === 'system' && ev.subtype === 'permission_denied') deniedEvents++;
    if (ev.parent_tool_use_id) continue;
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    if (ev.type === 'assistant') {
      const id = typeof ev.message?.id === 'string' ? ev.message.id : null;
      if (id === null || id !== message) turns++;
      message = id;
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) lastText = c.text.trim();
        if (c?.type !== 'tool_use') continue;
        const name = String(c.name);
        tools.set(name, (tools.get(name) ?? 0) + 1);
        if (name === 'Bash' && typeof c.input?.command === 'string' && isTestCommand(c.input.command, ctx.testCmd)) {
          pending.set(String(c.id), { at, turn: turns });
          testTurnSet.add(turns);
          testRuns++;
        }
      }
    } else if (ev.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        const output = resultText(c.content);
        if (c.is_error && output.trim()) anyFailure = output;
        const test = pending.get(String(c.tool_use_id));
        if (!test) continue;
        pending.delete(String(c.tool_use_id));
        if (test.at !== null && at !== null) testMs += Math.max(at - test.at, 0);
        lastTest = c.is_error ? 'failed' : 'passed';
        failStreak = c.is_error ? failStreak + 1 : 0;
        if (c.is_error) testFailure = output;
      }
    }
  }

  const subtype = typeof result?.subtype === 'string' ? result.subtype : '';
  const end: RunEnd = !result ? 'cut_off' : subtype === 'error_max_turns' ? 'max_turns' : subtype === 'success' ? 'ended' : 'error';
  const duration = typeof result?.duration_ms === 'number' ? result.duration_ms : first !== null && last !== null ? last - first : 0;
  const finalText = typeof result?.result === 'string' && result.result.trim() ? result.result.trim() : lastText;
  const excerpt = testFailure ?? anyFailure;
  const summary: Omit<RunSummary, 'verdict'> = {
    end,
    turns,
    max_turns: limitFrom(result?.errors) ?? ctx.maxTurns,
    minutes: tenths(duration),
    test_minutes: tenths(testMs),
    tools: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    test_runs: testRuns,
    test_turns: testTurnSet.size,
    last_test: lastTest,
    refused: Array.isArray(result?.permission_denials) ? result.permission_denials.length : deniedEvents,
    excerpt: excerpt === null ? null : tail(excerpt),
    final_message: finalText === null ? null : cut(finalText, FINAL_MAX),
    code_comments: codeComments,
  };
  const verdict = verdictOf(summary, failStreak, subtype || 'an error');
  return { ...summary, verdict: codeComments ? `${verdict}; ${codeComments}` : verdict };
}
