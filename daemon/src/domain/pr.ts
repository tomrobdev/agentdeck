// What goes into a pull request. Pure: no I/O.

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

/**
 * Whether a task is held back by its `after_task`: the dependency must be done and, if it opened a PR,
 * that PR merged. Mirrors the claim query in db.ts. A missing dependency holds the task.
 */
export function isWaiting(
  task: { after_task: number | null },
  dependency: { status: string; pr_url: string | null; pr_state: string | null } | undefined,
): boolean {
  if (task.after_task === null) return false;
  if (!dependency || dependency.status !== 'done') return true;
  return dependency.pr_url !== null && dependency.pr_state !== 'merged';
}

/** Map `gh pr view --json state` output ("OPEN", "MERGED", "CLOSED") to a PR state. */
export function parsePrState(state: string): 'open' | 'merged' | 'closed' | null {
  const s = state.trim().toLowerCase();
  return s === 'open' || s === 'merged' || s === 'closed' ? s : null;
}
