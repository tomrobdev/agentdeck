// Runs the planner: turns a repo's goals file into task proposals (see domain/proposals/proposals.ts).
import { type WriteStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { runClaude } from '../../adapters/claude.ts';
import { goalsPath, readGoals } from '../../adapters/goals.ts';
import { closeLog } from '../../adapters/run-log.ts';
import { LOG_DIR, ensureDirs } from '../../config.ts';
import type { App } from '../ports/app.ts';
import type { PlannerRunId, RepoId } from '../../domain/shared/index.ts';
import { type ProposalResult, buildPlannerPrompt, plannerArgs, plannerDueReason, selectProposals } from '../../domain/proposals/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { lastLine, plural } from '../../domain/shared/index.ts';
import { recordRateLimit, usageRecorder } from '../runs/claude-run.ts';
import { ActionError, requireRepo } from '../shared/input.ts';
import { notifyLater } from '../operations/notifications.ts';

/** How many of a repo's latest tasks the planner is shown, so it does not propose them again. */
const EXISTING_TASKS_SHOWN = 100;

/** Why the planner should run for this repo now, or null. */
export function plannerDue(app: App, repo: Repo, now = Date.now()): string | null {
  if (repo.archived_at) return null;
  const repoState = { hasGoals: !!readGoals(repo).trim(), openTasks: app.countOpen(repo.id), proposed_at: repo.proposed_at };
  return plannerDueReason(app.plannerSettings(), repoState, now);
}

export async function propose(app: App, repo: Repo): Promise<ProposalResult> {
  const goals = readGoals(repo);
  if (!goals.trim()) return { outcome: 'no_goals', tasks: [], skipped: [], note: `write goals in ${goalsPath(repo)} first` };

  ensureDirs();
  const logPath = join(LOG_DIR, `proposals-${repo.name}-${Date.now()}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  // A stream with no 'error' listener crashes the daemon when its file cannot be written.
  log.on('error', () => {});
  const runId = app.startPlannerRun(repo.id, logPath);
  try {
    return await planRepo(app, repo, goals, runId, log);
  } catch (err) {
    // Whatever threw, the row must end: an open one takes a slot until the next daemon start.
    app.finishPlannerRun(runId, 'failed', 0, `planner crashed: ${lastLine(String(err))}`);
    throw err;
  } finally {
    await closeLog(log).catch(() => {});
  }
}

async function planRepo(app: App, repo: Repo, goals: string, runId: PlannerRunId, log: WriteStream): Promise<ProposalResult> {
  const s = app.plannerSettings();
  const existing = app.tasksForRepo(repo.id, EXISTING_TASKS_SHOWN);

  const run = await runClaude({
    args: plannerArgs(buildPlannerPrompt(repo, goals, existing, s.max_tasks), s.model),
    cwd: repo.path,
    log,
    env: { AGENTDECK_PLANNER: '1' },
    onSpawn: (pid) => app.setPlannerRunPid(runId, pid),
    onUsage: usageRecorder(app),
  });

  if (run.rateLimitedUntil) {
    recordRateLimit(app, run.rateLimitedUntil);
    app.finishPlannerRun(runId, 'rate_limited', 0, null);
    return { outcome: 'rate_limited', tasks: [], skipped: [], note: null };
  }
  const out = run.result?.structured_output as { tasks?: unknown[]; note?: string } | undefined;
  if (!run.result || run.result.is_error || !Array.isArray(out?.tasks)) {
    const note = run.result?.subtype ?? `planner exited with code ${run.exitCode}`;
    app.finishPlannerRun(runId, 'failed', 0, note);
    return { outcome: 'failed', tasks: [], skipped: [], note };
  }

  const { accepted, skipped } = selectProposals(
    out.tasks,
    existing.map((t) => t.title),
    s.max_tasks,
  );
  const created = accepted.map((p) =>
    app.addTask({ repo_id: repo.id, ...p, status: repo.auto_approve ? 'queued' : 'proposed', source: 'planner' }),
  );

  const note = out.note?.trim() || null;
  app.finishPlannerRun(runId, created.length ? 'proposed' : 'nothing', created.length, note);
  if (created.length) {
    notifyLater(app, {
      kind: 'proposed',
      title: repo.auto_approve
        ? `Planner queued ${plural(created.length, 'task')} in ${repo.name}`
        : `${plural(created.length, 'task')} to approve in ${repo.name}`,
      body: created.map((t) => `• ${t.title}`).join('\n'),
    });
  }
  return { outcome: created.length ? 'proposed' : 'nothing', tasks: created, skipped, note };
}

const proposing = new Set<RepoId>();

/** Run the planner for one repo now, regardless of its schedule. */
export async function proposeNow(app: App, nameOrId: string | number): Promise<ProposalResult> {
  const repo = requireRepo(app, nameOrId);
  if (repo.archived_at) throw new ActionError(`${repo.name} is archived; unarchive it first`);
  if (proposing.has(repo.id)) throw new ActionError(`already proposing tasks for ${repo.name}`);
  proposing.add(repo.id);
  try {
    return await propose(app, repo);
  } finally {
    proposing.delete(repo.id);
  }
}
