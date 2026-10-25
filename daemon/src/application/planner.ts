// Runs the planner: turns a repo's goals file into task proposals (see domain/planner/proposals.ts).
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { runClaude } from '../adapters/claude.ts';
import { goalsPath, readGoals } from '../adapters/goals.ts';
import { closeLog } from '../adapters/run-log.ts';
import { LOG_DIR, ensureDirs } from '../config.ts';
import type { Db } from '../db/index.ts';
import { type ProposalResult, buildPlannerPrompt, plannerArgs, plannerDueReason, selectProposals } from '../domain/planner/proposals.ts';
import type { Repo } from '../domain/repo/repo.ts';
import { recordRateLimit, usageRecorder } from './run/claude-run.ts';
import { ActionError, requireRepo } from './input.ts';
import { notifyLater } from './notifications.ts';

/** Why the planner should run for this repo now, or null. */
export function plannerDue(db: Db, repo: Repo, now = Date.now()): string | null {
  if (repo.archived_at) return null;
  const repoState = { hasGoals: !!readGoals(repo).trim(), openTasks: db.countOpen(repo.id), planned_at: repo.planned_at };
  return plannerDueReason(db.plannerSettings(), repoState, now);
}

export async function propose(db: Db, repo: Repo): Promise<ProposalResult> {
  const goals = readGoals(repo);
  if (!goals.trim()) return { outcome: 'no_goals', tasks: [], skipped: [], note: `write goals in ${goalsPath(repo)} first` };

  ensureDirs();
  const s = db.plannerSettings();
  const logPath = join(LOG_DIR, `proposals-${repo.name}-${Date.now()}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const runId = db.startPlannerRun(repo.id, logPath);
  const existing = db.tasksForRepo(repo.id, 100);

  const run = await runClaude({
    args: plannerArgs(buildPlannerPrompt(repo, goals, existing, s.max_tasks), s.model),
    cwd: repo.path,
    log,
    env: { AGENTDECK_PLANNER: '1' },
    onSpawn: (pid) => db.setPlannerRunPid(runId, pid),
    onUsage: usageRecorder(db),
  });
  await closeLog(log);

  if (run.rateLimitedUntil) {
    recordRateLimit(db, run.rateLimitedUntil);
    db.finishPlannerRun(runId, 'rate_limited', 0, null);
    return { outcome: 'rate_limited', tasks: [], skipped: [], note: null };
  }
  const out = run.result?.structured_output as { tasks?: unknown[]; note?: string } | undefined;
  if (!run.result || run.result.is_error || !Array.isArray(out?.tasks)) {
    const note = run.result?.subtype ?? `planner exited with code ${run.exitCode}`;
    db.finishPlannerRun(runId, 'failed', 0, note);
    return { outcome: 'failed', tasks: [], skipped: [], note };
  }

  const { accepted, skipped } = selectProposals(
    out.tasks,
    existing.map((t) => t.title),
    s.max_tasks,
  );
  const created = accepted.map((p) =>
    db.addTask({ repo_id: repo.id, ...p, status: repo.auto_approve ? 'queued' : 'proposed', source: 'planner' }),
  );

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

const proposing = new Set<number>();

/** Run the planner for one repo now, regardless of its schedule. */
export async function proposeNow(db: Db, nameOrId: string | number): Promise<ProposalResult> {
  const repo = requireRepo(db, nameOrId);
  if (repo.archived_at) throw new ActionError(`${repo.name} is archived; unarchive it first`);
  if (proposing.has(repo.id)) throw new ActionError(`already proposing tasks for ${repo.name}`);
  proposing.add(repo.id);
  try {
    return await propose(db, repo);
  } finally {
    proposing.delete(repo.id);
  }
}
