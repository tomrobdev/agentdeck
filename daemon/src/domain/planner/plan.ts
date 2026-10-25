// Turning a repo's goals into task proposals: the prompt, the answer's shape, and which proposals to keep.
// Pure: no I/O. The planner runs read-only in the repo's main checkout and answers in PLAN_SCHEMA.
import type { Repo } from '../repo/repo.ts';
import { MODELS, OPEN_STATUSES, type Task } from '../task/task.ts';

export interface PlannerSettings {
  enabled: boolean;
  interval_hours: number;
  max_tasks: number;
  model: string;
}

export interface PlannerRun {
  id: number;
  repo_id: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null; // proposed | nothing | failed | rate_limited
  proposed: number;
  note: string | null;
  log_path: string;
  pid: number | null; // the planner's claude process group while it runs, for crash recovery
}

export interface PlanResult {
  outcome: 'proposed' | 'nothing' | 'failed' | 'rate_limited' | 'no_goals';
  tasks: Task[];
  skipped: string[];
  note: string | null;
}

/** The sections every task prompt has, in order. The delegate skill (.claude/skills/delegate) asks for the same. */
export const PROMPT_SECTIONS = `Goal: what the task achieves, in a sentence or two.
Context: the files to start from, why it is needed, related tasks or plans.
Change: what to do.
Out of scope: what not to touch.
Constraints: limits the agent must keep to, such as no new dependencies or no changes to package.json.
Definition of done: the test command passing, plus concrete checks a reviewer can confirm.

A task linked to a plan (agentdeck add --plan) needs only Goal, Out of scope and Constraints: the daemon puts the linked steps into the worker's prompt, and they supply Change and Definition of done.`;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Imperative, under 70 characters' },
          prompt: { type: 'string', description: 'Instructions for the coding agent, in the sections listed in the prompt' },
          priority: { type: 'integer', minimum: 0, maximum: 3 },
          model: { type: 'string', enum: MODELS },
        },
        required: ['title', 'prompt', 'priority', 'model'],
      },
    },
    note: { type: 'string', description: 'One line on what you looked at, or why there is nothing to propose' },
  },
  required: ['tasks'],
};

const PLANNER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git diff*)', 'Bash(ls*)', 'Bash(cat*)'];
const PLANNER_DENIED = ['Edit', 'Write', 'NotebookEdit', 'Bash(git push*)', 'Bash(git commit*)', 'Bash(rm*)'];

export function buildPlannerPrompt(repo: Repo, goals: string, tasks: Task[], maxTasks: number): string {
  const open = tasks.filter((t) => OPEN_STATUSES.includes(t.status));
  const recent = tasks.filter((t) => !OPEN_STATUSES.includes(t.status)).slice(0, 15);
  const line = (t: Task) => `- #${t.id} [${t.status}] ${t.title}${t.blocked_reason ? ` (${t.blocked_reason.slice(0, 120)})` : ''}`;
  return `You are the planner for the repository "${repo.name}". Read the goals below and look around the code (you are read-only).
Propose at most ${maxTasks} new tasks that move the goals forward. An unattended coding agent will do each task alone, in its own git branch, with about 40 turns and the repo's test command (${repo.test_cmd ?? 'none'}) as the check.

Each task must be:
- small enough for one focused session, and independent of the other proposals
- testable, with a concrete definition of done
- not already covered by an open or recent task below, and not something the goals rule out
Prefer the highest-value next step. Use haiku for mechanical work, sonnet by default, opus only for genuinely hard tasks.
If nothing is worth doing right now, return an empty list and say why in "note".

Write each prompt in these sections, one paragraph or list each, headed by the section name:
${PROMPT_SECTIONS}

## Goals
${goals.trim()}

## Open tasks
${open.map(line).join('\n') || '(none)'}

## Recently finished
${recent.map(line).join('\n') || '(none)'}`;
}

export function plannerArgs(prompt: string, model: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--max-turns',
    '15',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    ...PLANNER_TOOLS,
    '--disallowedTools',
    ...PLANNER_DENIED,
    '--json-schema',
    JSON.stringify(PLAN_SCHEMA),
  ];
}

/** Why the planner should run for a repo now, or null. `planned_at` is SQLite UTC. */
export function plannerDueReason(
  s: PlannerSettings,
  repo: { hasGoals: boolean; openTasks: number; planned_at: string | null },
  now: number,
): string | null {
  if (!s.enabled || !repo.hasGoals) return null;
  if (repo.openTasks > 0) return null;
  const last = repo.planned_at ? Date.parse(repo.planned_at.replace(' ', 'T') + 'Z') : 0;
  if (now - last < s.interval_hours * 3_600_000) return null;
  return 'queue is empty';
}

export interface Proposal {
  title: string;
  prompt: string;
  priority: number;
  model: string | undefined;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Clean up the planner's raw answer: drop empty entries and anything repeating an existing title, then cap. */
export function selectProposals(raw: unknown[], existingTitles: string[], max: number): { accepted: Proposal[]; skipped: string[] } {
  const seen = new Set(existingTitles.map(norm));
  const accepted: Proposal[] = [];
  const skipped: string[] = [];
  for (const r of raw as any[]) {
    const title = String(r?.title ?? '')
      .trim()
      .slice(0, 100);
    const prompt = String(r?.prompt ?? '').trim();
    if (!title || !prompt) continue;
    if (seen.has(norm(title)) || accepted.length >= max) {
      skipped.push(title);
      continue;
    }
    seen.add(norm(title));
    accepted.push({
      title,
      prompt,
      priority: Math.max(0, Math.min(3, Number(r.priority) || 0)),
      model: MODELS.includes(r.model) ? r.model : undefined,
    });
  }
  return { accepted, skipped };
}
