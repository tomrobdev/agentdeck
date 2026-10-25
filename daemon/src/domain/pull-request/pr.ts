// What goes into a pull request. Pure: no I/O.

/** What the daemon does when a task is done: nothing, open a draft PR, or open a ready PR. */
export type PrMode = 'off' | 'draft' | 'ready';
export const PR_MODES: PrMode[] = ['off', 'draft', 'ready'];
/** `failed` is the daemon's own: the task finished but its PR could not be opened (there is no pr_url). */
export type PrState = 'open' | 'merged' | 'closed' | 'failed';

export interface PrRun {
  kind?: string; // 'resolve' runs are listed but never supply the final message
  attempt: number;
  outcome: string | null;
  num_turns: number | null;
  cost_usd: number;
  tests_passed: number | null;
  result_text: string | null;
}

/** The agent's final message without its trailing "STATUS: DONE" line. */
export function finalMessage(runs: PrRun[]): string {
  const text = runs.filter((r) => r.kind !== 'resolve').at(-1)?.result_text ?? '';
  return text.replace(/\n?\s*STATUS:\s*(DONE|BLOCKED)\b.*$/i, '').trim();
}

/** The plan a task carries out: its path and the linked steps as the branch has them. */
export interface PrPlan {
  path: string;
  steps: { title: string; status: string; done: string[] }[];
}

/** The "Plan" section: each linked step with its status, and its done criteria as a checklist for the reviewer. */
function planSection(plan: PrPlan): string[] {
  const out = [`## Plan: \`${plan.path}\``];
  for (const step of plan.steps) {
    out.push('', `**${step.title}** (${step.status})`);
    if (step.done.length) out.push('', ...step.done.map((d) => `- [ ] ${d}`));
  }
  return [...out, ''];
}

/** The agent's final message, the linked plan's steps, a table of the task's runs, and a signature. */
export function buildPrBody(task: { id: number }, runs: PrRun[], plan: PrPlan | null = null): string {
  const rows = runs.map((r) => {
    const tests = r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail';
    return `| ${r.attempt}${r.kind === 'resolve' ? ' (conflicts)' : ''} | ${r.outcome ?? '-'} | ${r.num_turns ?? '-'} | $${r.cost_usd.toFixed(2)} | ${tests} |`;
  });
  return [
    finalMessage(runs) || '(the agent left no final message)',
    '',
    ...(plan && plan.steps.length ? planSection(plan) : []),
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
