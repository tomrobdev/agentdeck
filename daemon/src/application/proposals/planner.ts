// Runs the planner: turns a repo's goals file into task proposals (see domain/proposals/proposals.ts).
import { type WriteStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR, ensureDirs } from '#src/config.ts';
import type { App } from '#application/ports/app.ts';
import type { PlannerRunId, RepoId } from '#domain/shared/index.ts';
import { type ProposalResult, buildPlannerPrompt, plannerArgs, plannerDueReason, selectProposals } from '#domain/proposals/index.ts';
import type { Repo } from '#domain/repos/index.ts';
import { limitReason } from '#domain/runs/index.ts';
import { lastLine, plural } from '#domain/shared/index.ts';
import { ISSUE_LABELS, newTaskModel } from '#domain/work/index.ts';
import { recordRateLimit, usageRecorder } from '#application/runs/claude-run.ts';
import { ActionError, requireRepo } from '#application/shared/input.ts';
import { notifyLater } from '#application/operations/notifications.ts';

const EXISTING_TASKS_SHOWN = 100;

export function plannerDue(app: App, repo: Repo, now = Date.now()): string | null {
  if (repo.archived_at) return null;
  const repoState = { hasGoals: !!app.goals.read(repo).trim(), openTasks: app.countOpen(repo.id), proposed_at: repo.proposed_at };
  return plannerDueReason(app.plannerSettings(), repoState, now);
}

export async function propose(app: App, repo: Repo): Promise<ProposalResult> {
  const goals = app.goals.read(repo);
  if (!goals.trim()) return { outcome: 'no_goals', tasks: [], skipped: [], note: `write goals in ${app.goals.path(repo)} first` };

  ensureDirs();
  const logPath = join(LOG_DIR, `proposals-${repo.name}-${Date.now()}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  log.on('error', () => {});
  const runId = app.startPlannerRun(repo.id, logPath);
  try {
    return await planRepo(app, repo, goals, runId, log);
  } catch (err) {
    app.finishPlannerRun(runId, 'failed', 0, `planner crashed: ${lastLine(String(err))}`);
    throw err;
  } finally {
    await app.runLog.close(log).catch(() => {});
  }
}

async function planRepo(app: App, repo: Repo, goals: string, runId: PlannerRunId, log: WriteStream): Promise<ProposalResult> {
  const s = app.plannerSettings();
  const existing = app.tasksForRepo(repo.id, EXISTING_TASKS_SHOWN);

  const run = await app.agent.run({
    args: plannerArgs(buildPlannerPrompt(repo, goals, existing, s.max_tasks), s.model),
    cwd: repo.path,
    log,
    env: { AGENTDECK_PLANNER: '1' },
    onSpawn: (pid) => app.setPlannerRunPid(runId, pid),
    onUsage: usageRecorder(app),
  });

  if (run.timedOut) {
    const note = limitReason(run.timedOut);
    app.finishPlannerRun(runId, 'failed', 0, note);
    return { outcome: 'failed', tasks: [], skipped: [], note };
  }
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
  if (repo.issues) return openIssues(app, repo, runId, accepted, skipped, out.note?.trim() || null);
  const { default_model } = app.modelSettings();
  const created = accepted.map((p) =>
    app.addTask({
      repo_id: repo.id,
      ...p,
      model: newTaskModel(p.model, repo, default_model).model,
      status: repo.auto_approve ? 'queued' : 'proposed',
      source: 'planner',
    }),
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

async function openIssues(
  app: App,
  repo: Repo,
  runId: PlannerRunId,
  accepted: { title: string; prompt: string }[],
  skipped: string[],
  note: string | null,
): Promise<ProposalResult> {
  const labels = repo.auto_approve ? [ISSUE_LABELS.ready] : [];
  const urls: string[] = [];
  for (const p of accepted) {
    const body = `${p.prompt.trim()}\n\nProposed by AgentDeck's planner from ${repo.name}'s goals.`;
    urls.push(await app.issues.create(repo.path, { title: p.title, body, labels }));
  }
  if (!urls.length) {
    app.finishPlannerRun(runId, 'nothing', 0, note);
    return { outcome: 'nothing', tasks: [], skipped, note };
  }
  const said = `opened ${urls.join(', ')}; the next issue poll makes them proposals${note ? `. ${note}` : ''}`;
  app.finishPlannerRun(runId, 'proposed', urls.length, said);
  notifyLater(app, {
    kind: 'proposed',
    title: `Planner opened ${plural(urls.length, 'issue')} in ${repo.name}`,
    body: accepted.map((p) => `• ${p.title}`).join('\n'),
  });
  return { outcome: 'proposed', tasks: [], skipped, note: said };
}

const proposing = new Set<RepoId>();

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
