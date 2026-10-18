// Turns a repo's goals file into small, testable task proposals.
// The planner runs read-only in the repo's main checkout and answers in a fixed JSON shape.
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOALS_DIR, LOG_DIR, ensureDirs } from './config.ts';
import { runClaude } from './claude.ts';
import type { Db, Repo, Task } from './db.ts';
import { notifyLater } from './notify.ts';

export interface PlannerSettings {
  enabled: boolean;
  interval_hours: number;
  max_tasks: number;
  model: string;
}

export function plannerSettings(db: Db): PlannerSettings {
  return {
    enabled: db.getSetting('planner_enabled', '1') === '1',
    interval_hours: Number(db.getSetting('planner_interval_hours', '3')),
    max_tasks: Number(db.getSetting('planner_max_tasks', '3')),
    model: db.getSetting('planner_model', 'sonnet'),
  };
}

export function goalsPath(repo: Pick<Repo, 'name'>): string {
  return join(GOALS_DIR, `${repo.name}.md`);
}

export function readGoals(repo: Pick<Repo, 'name'>): string {
  const p = goalsPath(repo);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

export function writeGoals(repo: Pick<Repo, 'name'>, text: string): void {
  ensureDirs();
  writeFileSync(goalsPath(repo), text);
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Imperative, under 70 characters' },
          prompt: { type: 'string', description: 'Instructions for the coding agent, ending with a concrete definition of done' },
          priority: { type: 'integer', minimum: 0, maximum: 3 },
          model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
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
const OPEN: Task['status'][] = ['proposed', 'queued', 'running', 'cancel_requested'];

export function buildPlannerPrompt(repo: Repo, goals: string, tasks: Task[], maxTasks: number): string {
  const open = tasks.filter((t) => OPEN.includes(t.status));
  const recent = tasks.filter((t) => !OPEN.includes(t.status)).slice(0, 15);
  const line = (t: Task) => `- #${t.id} [${t.status}] ${t.title}${t.blocked_reason ? ` (${t.blocked_reason.slice(0, 120)})` : ''}`;
  return `You are the planner for the repository "${repo.name}". Read the goals below and look around the code (you are read-only).
Propose at most ${maxTasks} new tasks that move the goals forward. An unattended coding agent will do each task alone, in its own git branch, with about 40 turns and the repo's test command (${repo.test_cmd ?? 'none'}) as the check.

Each task must be:
- small enough for one focused session, and independent of the other proposals
- testable, with a prompt that ends with a concrete definition of done
- not already covered by an open or recent task below, and not something the goals rule out
Prefer the highest-value next step. Use haiku for mechanical work, sonnet by default, opus only for genuinely hard tasks.
If nothing is worth doing right now, return an empty list and say why in "note".

## Goals
${goals.trim()}

## Open tasks
${open.map(line).join('\n') || '(none)'}

## Recently finished
${recent.map(line).join('\n') || '(none)'}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface PlanResult {
  outcome: 'proposed' | 'nothing' | 'failed' | 'rate_limited' | 'no_goals';
  tasks: Task[];
  skipped: string[];
  note: string | null;
}

/** Why the planner should run for this repo now, or null. */
export function plannerDue(db: Db, repo: Repo, now = Date.now()): string | null {
  const s = plannerSettings(db);
  if (!s.enabled || !readGoals(repo).trim()) return null;
  if (db.countOpen(repo.id) > 0) return null;
  const last = repo.planned_at ? Date.parse(repo.planned_at.replace(' ', 'T') + 'Z') : 0;
  if (now - last < s.interval_hours * 3_600_000) return null;
  return 'queue is empty';
}

export async function planRepo(db: Db, repo: Repo): Promise<PlanResult> {
  const goals = readGoals(repo);
  if (!goals.trim()) return { outcome: 'no_goals', tasks: [], skipped: [], note: `write goals in ${goalsPath(repo)} first` };

  ensureDirs();
  const s = plannerSettings(db);
  const logPath = join(LOG_DIR, `plan-${repo.name}-${Date.now()}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const runId = db.startPlannerRun(repo.id, logPath);
  const existing = db.tasksForRepo(repo.id, 100);

  const run = await runClaude(db, {
    args: [
      '-p',
      buildPlannerPrompt(repo, goals, existing, s.max_tasks),
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      s.model,
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
    ],
    cwd: repo.path,
    log,
    env: { AGENTDECK_PLANNER: '1' },
    onSpawn: (pid) => db.setPlannerRunPid(runId, pid),
  });
  log.end();

  if (run.rateLimitedUntil) {
    db.setSetting('rate_limited_until', String(run.rateLimitedUntil));
    db.finishPlannerRun(runId, 'rate_limited', 0, null);
    return { outcome: 'rate_limited', tasks: [], skipped: [], note: null };
  }
  const out = run.result?.structured_output as { tasks?: unknown[]; note?: string } | undefined;
  if (!run.result || run.result.is_error || !Array.isArray(out?.tasks)) {
    const note = run.result?.subtype ?? `planner exited with code ${run.exitCode}`;
    db.finishPlannerRun(runId, 'failed', 0, note);
    return { outcome: 'failed', tasks: [], skipped: [], note };
  }

  // Drop anything that repeats an existing task, then cap.
  const seen = new Set(existing.map((t) => norm(t.title)));
  const created: Task[] = [];
  const skipped: string[] = [];
  for (const raw of out.tasks as any[]) {
    const title = String(raw?.title ?? '')
      .trim()
      .slice(0, 100);
    const prompt = String(raw?.prompt ?? '').trim();
    if (!title || !prompt) continue;
    if (seen.has(norm(title)) || created.length >= s.max_tasks) {
      skipped.push(title);
      continue;
    }
    seen.add(norm(title));
    created.push(
      db.addTask({
        repo_id: repo.id,
        title,
        prompt,
        priority: Math.max(0, Math.min(3, Number(raw.priority) || 0)),
        model: ['haiku', 'sonnet', 'opus'].includes(raw.model) ? raw.model : undefined,
        status: repo.auto_approve ? 'queued' : 'proposed',
        source: 'planner',
      }),
    );
  }

  const note = out.note?.trim() || null;
  db.finishPlannerRun(runId, created.length ? 'proposed' : 'nothing', created.length, note);
  if (created.length) {
    notifyLater(db, {
      kind: 'proposed',
      title: repo.auto_approve
        ? `Planner queued ${created.length} task(s) in ${repo.name}`
        : `${created.length} task(s) to approve in ${repo.name}`,
      body: created.map((t) => `• ${t.title}`).join('\n'),
    });
  }
  return { outcome: created.length ? 'proposed' : 'nothing', tasks: created, skipped, note };
}
