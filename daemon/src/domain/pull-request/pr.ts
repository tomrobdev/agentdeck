// What goes into a pull request. Pure: no I/O.

/** What the daemon does when a task is done: nothing, open a draft PR, or open a ready PR. */
export type PrMode = 'off' | 'draft' | 'ready';
export const PR_MODES: PrMode[] = ['off', 'draft', 'ready'];
/** `failed` is the daemon's own: the task finished but its PR could not be opened (there is no pr_url). */
export type PrState = 'open' | 'merged' | 'closed' | 'failed';

export interface PrRun {
  attempt: number;
  outcome: string | null;
  num_turns: number | null;
  cost_usd: number;
  tests_passed: number | null;
  result_text: string | null;
}

/** The agent's final message without its trailing "STATUS: DONE" line. */
export function finalMessage(runs: PrRun[]): string {
  const text = runs.at(-1)?.result_text ?? '';
  return text.replace(/\n?\s*STATUS:\s*(DONE|BLOCKED)\b.*$/i, '').trim();
}

/** The agent's final message, a table of the task's runs, and a signature. */
export function buildPrBody(task: { id: number }, runs: PrRun[]): string {
  const rows = runs.map((r) => {
    const tests = r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail';
    return `| ${r.attempt} | ${r.outcome ?? '-'} | ${r.num_turns ?? '-'} | $${r.cost_usd.toFixed(2)} | ${tests} |`;
  });
  return [
    finalMessage(runs) || '(the agent left no final message)',
    '',
    '| Attempt | Outcome | Turns | Cost | Tests |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Made by AgentDeck task #${task.id}.`,
  ].join('\n');
}

/** Map `gh pr view --json state` output ("OPEN", "MERGED", "CLOSED") to a PR state. */
export function parsePrState(state: string): PrState | null {
  const s = state.trim().toLowerCase();
  return s === 'open' || s === 'merged' || s === 'closed' ? s : null;
}
