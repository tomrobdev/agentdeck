// The sequence every task-bound claude run shares: log, run row, settings, the process, and what its end means.
import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { rootInfo } from '../../adapters/repo-root.ts';
import { closeLog, writeEvent, writeSettings } from '../../adapters/run-log.ts';
import { LOG_DIR, ensureDirs } from '../../config.ts';
import type { App } from '../ports/app.ts';
import type { RunId } from '../../domain/shared/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { allowedTools } from '../../domain/repos/index.ts';
import { type ClaudeResult, type ClaudeRun, type UsageWindow, START_LIVE, nextLive } from '../../domain/runs/index.ts';
import { claudeArgs } from '../../domain/runs/index.ts';
import { settingsPath, workerSettings } from '../../domain/runs/index.ts';
import { type Outcome, type Run, type RunClass, type RunKind, classifyRun, resultFields, resumeFailed } from '../../domain/runs/index.ts';
import type { Task } from '../../domain/work/index.ts';
import { lastLine } from '../../domain/shared/index.ts';

/**
 * Write the sandbox and file-rule settings for a claude run in `worktree` (docs/adr/0001-worker-sandbox.md)
 * next to its log, and return their path for `--settings`.
 */
export function runSettings(repo: Repo, worktree: string, logPath: string): string {
  const path = settingsPath(logPath);
  writeSettings(path, workerSettings({ worktree, sandbox: repo.sandbox, network: repo.network }));
  return path;
}

/** A run row and its log, before claude starts. */
export interface OpenedRun {
  runId: RunId;
  logPath: string;
  log: WriteStream;
  /** Set by `endTaskRun`: the row is finished and the log closed, and neither happens again. */
  ended?: boolean;
}

/** Open the log and the run row. A work run is named by its attempt, a resolve or unblock run by its kind and the time it started. */
export function openTaskRun(app: App, task: Task, kind: RunKind): OpenedRun {
  ensureDirs();
  const name = kind === 'work' ? `attempt-${task.attempts}` : `${kind}-${Date.now()}`;
  const logPath = join(LOG_DIR, `task-${task.id}-${name}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const runId = app.startRun(task.id, task.attempts, logPath, kind);
  return { runId, logPath, log };
}

/**
 * End an opened run: close its log, then finish its row with `outcome` (and `reason` as its result text when `fields`
 * has none). The one way a work or resolve run ends. A run already ended is left as it is, so a row is never finished twice.
 */
export async function endTaskRun(app: App, opened: OpenedRun, outcome: Outcome, reason?: string, fields: Partial<Run> = {}): Promise<void> {
  if (opened.ended) return;
  opened.ended = true;
  await closeLog(opened.log);
  app.finishRun(opened.runId, { ...fields, outcome, ...(reason && !fields.result_text ? { result_text: reason } : {}) });
}

/** What a task run came to. `fields` are the run row's columns that claude's exit decides. */
export interface TaskRunEnd extends OpenedRun {
  end: RunClass<ClaudeResult>;
  result: ClaudeResult | undefined;
  fields: Partial<Run>;
}

/** A claude session to continue instead of starting afresh, the prompt that continues it and the turns it has left. */
export interface ResumeRun {
  session: string;
  prompt: string;
  maxTurns: number;
}

/**
 * Run claude on a task in `worktree`: write the run settings, start the process with the cancel, pid, session and
 * usage callbacks, and record a rate limit. `opened` is a run the caller opened earlier (it needed the log before
 * claude). With `resume`, claude continues that session; if it cannot (the session is gone), a fresh claude with
 * `prompt` takes over in the same run. The caller decides what the end means and calls `finishRun`. Throws if the
 * settings cannot be written. `maxTurns` and `systemPrompt` replace the task's and the worker's (an unblock run's are
 * its own). A work or resolve run stops when a person cancels the task; an unblock run, whose task is blocked, stops
 * as soon as the task is anything else (a person retried, cancelled or marked it done).
 */
export async function startTaskRun(
  app: App,
  task: Task,
  opts: {
    kind: RunKind;
    repo: Repo;
    worktree: string;
    prompt: string;
    opened?: OpenedRun;
    resume?: ResumeRun;
    maxTurns?: number;
    systemPrompt?: string;
  },
): Promise<TaskRunEnd> {
  const opened = opts.opened ?? openTaskRun(app, task, opts.kind);
  const { runId, logPath, log } = opened;
  const { repo, worktree, resume } = opts;
  const settings = runSettings(repo, worktree, logPath);
  // Local to this run, not module state: the live state goes to the run row, where the queue reads it.
  let live = START_LIVE;
  const allowed = allowedTools(repo, rootInfo(worktree));
  const cancelled =
    opts.kind === 'unblock' ? () => app.getTask(task.id)?.status !== 'blocked' : () => app.getTask(task.id)?.status === 'cancel_requested';
  const start = (prompt: string, session: string | null, maxTurns = opts.maxTurns ?? task.max_turns): Promise<ClaudeRun> =>
    app.agent.run({
      args: claudeArgs(task, allowed, prompt, repo.test_cmd, settings, session, maxTurns, opts.systemPrompt),
      cwd: worktree,
      log,
      env: { AGENTDECK_TASK_ID: String(task.id) },
      shouldCancel: cancelled,
      onSpawn: (pid) => app.setRunPid(runId, pid),
      onSession: (id) => app.setRunSession(runId, id),
      onUsage: usageRecorder(app),
      onEvent: (ev) => {
        const next = nextLive(live, ev);
        if (next.turns === live.turns && next.tool === live.tool) return;
        live = next;
        app.setRunLive(runId, live.turns, live.tool);
      },
    });
  let run: ClaudeRun;
  if (resume) {
    writeEvent(log, { type: 'agentdeck_resume', session_id: resume.session });
    run = await start(resume.prompt, resume.session, resume.maxTurns);
    if (resumeFailed(run)) {
      const why = run.stderr.trim() ? lastLine(run.stderr) : `claude exited with code ${run.exitCode}`;
      writeEvent(log, { type: 'agentdeck_resume_failed', session_id: resume.session, text: `${why}; starting afresh` });
      run = await start(opts.prompt, null);
    }
  } else {
    run = await start(opts.prompt, null);
  }
  const end = classifyRun(run);
  if (end.kind === 'rate_limited') app.setRateLimitedUntil(end.until);
  return { ...opened, end, result: run.result, fields: resultFields(run.result, run.exitCode, run.sessionId) };
}

/** The `onUsage` callback that stores each usage window claude reports. */
export function usageRecorder(app: App): (w: UsageWindow) => void {
  return (w) => app.recordUsageWindow(w.window, w.utilization, w.resets_at, w.status);
}

/** Remember that claude rejected a request on rate limits, so nothing starts until `until` (unix seconds). */
export function recordRateLimit(app: App, until: number): void {
  app.setRateLimitedUntil(until);
}
