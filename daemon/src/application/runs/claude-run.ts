// The sequence every task-bound claude run shares: log, run row, settings, the process, and what its end means.
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { LOG_DIR, ensureDirs } from '../../config.ts';
import type { App } from '../ports/app.ts';
import type { RunId } from '../../domain/shared/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { allowedTools } from '../../domain/repos/index.ts';
import { type ClaudeResult, type ClaudeRun, type UsageWindow, START_LIVE, nextLive } from '../../domain/runs/index.ts';
import { claudeArgs } from '../../domain/runs/index.ts';
import { settingsPath, workerSettings } from '../../domain/runs/index.ts';
import {
  type Outcome,
  type Run,
  type RunClass,
  type RunKind,
  type SummaryContext,
  classifyRun,
  resultFields,
  resumeFailed,
  runEndOf,
  runModel,
  runSummary,
} from '../../domain/runs/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { lastLine } from '../../domain/shared/index.ts';

export function runSettings(app: App, repo: Repo, worktree: string, logPath: string): string {
  const path = settingsPath(logPath);
  app.runLog.writeSettings(path, workerSettings({ worktree, sandbox: repo.sandbox, network: repo.network }));
  return path;
}

export interface OpenedRun {
  runId: RunId;
  logPath: string;
  log: WriteStream;
  model: string;
  ended?: boolean;
}

export function openTaskRun(app: App, task: Task, kind: RunKind, diffHash: string | null = null): OpenedRun {
  ensureDirs();
  const name = kind === 'work' ? `attempt-${task.attempts}` : `${kind}-${Date.now()}`;
  const logPath = join(LOG_DIR, `task-${task.id}-${name}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const model = runModel(kind, task, app.modelSettings());
  const runId = app.startRun(task.id, task.attempts, logPath, kind, model, diffHash);
  return { runId, logPath, log, model };
}

export async function endTaskRun(
  app: App,
  opened: OpenedRun,
  outcome: Outcome,
  reason?: string,
  fields: Partial<Run> = {},
  summary?: SummaryContext,
): Promise<void> {
  if (opened.ended) return;
  opened.ended = true;
  await app.runLog.close(opened.log);
  const events = summary && (outcome === 'failed' || outcome === 'blocked') ? readEvents(app, opened.logPath) : [];
  const ended = events.length && summary ? runEndOf(runSummary(events, summary)) : {};
  app.finishRun(opened.runId, { ...fields, ...ended, outcome, ...(reason && !fields.result_text ? { result_text: reason } : {}) });
}

function readEvents(app: App, path: string): unknown[] {
  try {
    return app.runLog.events(path);
  } catch {
    return [];
  }
}

export interface TaskRunEnd extends OpenedRun {
  end: RunClass<ClaudeResult>;
  result: ClaudeResult | undefined;
  fields: Partial<Run>;
}

export interface ResumeRun {
  session: string;
  prompt: string;
  maxTurns: number;
}

export async function startTaskRun(
  app: App,
  task: Task,
  opts: {
    kind: RunKind;
    repo: Repo;
    worktree: string;
    prompt: string;
    note?: string | null;
    opened?: OpenedRun;
    resume?: ResumeRun;
    maxTurns?: number;
    systemPrompt?: string;
    tools?: string[];
    disallowed?: string[];
    args?: string[];
    cancelled?: () => boolean;
  },
): Promise<TaskRunEnd> {
  const opened = opts.opened ?? openTaskRun(app, task, opts.kind);
  const { runId, logPath, log, model } = opened;
  const { repo, worktree, resume } = opts;
  const settings = runSettings(app, repo, worktree, logPath);
  let live = START_LIVE;
  const allowed = opts.tools ?? allowedTools(repo, await app.workspace.rootInfo(worktree));
  const cancelled =
    opts.cancelled ??
    (opts.kind === 'unblock'
      ? () => app.getTask(task.id)?.status !== 'blocked'
      : () => app.getTask(task.id)?.status === 'cancel_requested');
  const start = (prompt: string, session: string | null, maxTurns = opts.maxTurns ?? task.max_turns): Promise<ClaudeRun> => {
    app.runLog.event(log, { type: 'agentdeck_prompt', text: prompt, resume: session !== null, note: opts.note ?? null });
    return app.agent.run({
      args: claudeArgs(
        { model, max_turns: task.max_turns },
        allowed,
        prompt,
        repo.test_cmd,
        settings,
        session,
        maxTurns,
        opts.systemPrompt,
        { disallowed: opts.disallowed, args: opts.args },
      ),
      cwd: worktree,
      log,
      env: { AGENTDECK_TASK_ID: String(task.id) },
      shouldCancel: cancelled,
      onSpawn: (pid) => app.setRunPid(runId, pid),
      onSession: (id) => app.setRunSession(runId, id),
      onModel: (id) => app.setRunModelId(runId, id),
      onUsage: usageRecorder(app),
      onEvent: (ev) => {
        const next = nextLive(live, ev);
        if (next.turns === live.turns && next.tool === live.tool) return;
        live = next;
        app.setRunLive(runId, live.turns, live.tool);
      },
    });
  };
  let run: ClaudeRun;
  if (resume) {
    app.runLog.event(log, { type: 'agentdeck_resume', session_id: resume.session });
    run = await start(resume.prompt, resume.session, resume.maxTurns);
    if (resumeFailed(run)) {
      const why = run.stderr.trim() ? lastLine(run.stderr) : `claude exited with code ${run.exitCode}`;
      app.runLog.event(log, { type: 'agentdeck_resume_failed', session_id: resume.session, text: `${why}; starting afresh` });
      run = await start(opts.prompt, null);
    }
  } else {
    run = await start(opts.prompt, null);
  }
  const end = classifyRun(run);
  if (end.kind === 'rate_limited') app.setRateLimitedUntil(end.until);
  return { ...opened, end, result: run.result, fields: resultFields(run.result, run.exitCode, run.sessionId) };
}

export function usageRecorder(app: App): (w: UsageWindow) => void {
  return (w) => app.recordUsageWindow(w.window, w.utilization, w.resets_at, w.status);
}

export function recordRateLimit(app: App, until: number): void {
  app.setRateLimitedUntil(until);
}
