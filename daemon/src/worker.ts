import { execFile } from 'node:child_process';
import { type WriteStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { ALWAYS_DISALLOWED_TOOLS, DEFAULT_ALLOWED_TOOLS, LOG_DIR, WORKER_SYSTEM_PROMPT, ensureDirs } from './config.ts';
import { runClaude } from './claude.ts';
import type { Db, Repo, Run, Task } from './db.ts';
import { detectToolchain, isToolchain, toolchainTools } from './domain/toolchain.ts';
import { commitLeftovers, commitsAhead, ensureWorktree, rootInfo } from './git.ts';
import { notifyLater } from './notify.ts';
import { firstDenial, pauseRepo } from './pause.ts';

export type Outcome = 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';

export interface WorkerResult {
  outcome: Outcome;
  reason?: string;
}

export const TEST_TIMEOUT_MS = 15 * 60_000;
export const SETUP_TIMEOUT_MS = 10 * 60_000;

export function buildPrompt(task: Task, previousRuns: Run[]): string {
  const last = previousRuns.at(-1);
  if (!last) return task.prompt;
  return [
    task.prompt,
    '',
    `--- This is attempt ${task.attempts}. The previous attempt ended as "${last.outcome}". ---`,
    last.tests_passed === 0 ? 'The test command failed after the previous attempt.' : '',
    last.result_text ? `Previous final message:\n${last.result_text.slice(0, 4000)}` : '',
    'Your earlier commits are already on this branch. Continue from there.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The repo's own rules if it has them, otherwise the generic defaults plus its toolchain's rules.
 * Repos registered before toolchain detection have no toolchain, so detect it from `dir` on the fly.
 */
export function effectiveTools(repo: Repo, dir: string): string[] {
  if (repo.allowed_tools) return JSON.parse(repo.allowed_tools);
  const { files, scripts } = rootInfo(dir);
  const toolchain = isToolchain(repo.toolchain) ? repo.toolchain : detectToolchain(files, scripts)?.toolchain;
  return [...DEFAULT_ALLOWED_TOOLS, ...(toolchain ? toolchainTools(toolchain, scripts) : [])];
}

export function claudeArgs(task: Task, allowed: string[], prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    task.model,
    '--max-turns',
    String(task.max_turns),
    '--permission-mode',
    'dontAsk',
    // One argv entry per rule: patterns like "Bash(npm test*)" contain spaces.
    '--allowedTools',
    ...allowed,
    '--disallowedTools',
    ...ALWAYS_DISALLOWED_TOOLS,
    '--append-system-prompt',
    WORKER_SYSTEM_PROMPT,
  ];
}

/** Pull "STATUS: BLOCKED: reason" out of the agent's final message. */
export function parseStatus(text: string | undefined): { blocked: boolean; reason?: string; declared: boolean } {
  const lines = (text ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    const m = line.trim().match(/^STATUS:\s*(DONE|BLOCKED)(?::\s*(.*))?$/i);
    if (m) return { blocked: m[1].toUpperCase() === 'BLOCKED', reason: m[2]?.trim(), declared: true };
  }
  return { blocked: false, declared: false };
}

/** End the run log and wait until it is on disk, so readers never see a finished run with a partial log. */
function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve) => log.end(() => resolve()));
}

/** Run a repo command (setup or tests) in the worktree. */
export function runCommand(cmd: string, cwd: string, timeout: number): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(-20_000);
      resolve({ passed: !err, output: output || (err ? err.message : '') });
    });
  });
}

/** The last non-empty line of a command's output, for a one-line reason. */
export function lastLine(output: string): string {
  return (
    output
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? 'no output'
  ).slice(0, 300);
}

/** Run one attempt of a task that the scheduler has already claimed (status = running). */
export async function runTask(db: Db, task: Task): Promise<WorkerResult> {
  ensureDirs();
  const repo = db.getRepo(task.repo_id);
  if (!repo) return finish(db, task, null, { outcome: 'failed', reason: `repo ${task.repo_id} not found` });

  let wt: { branch: string; path: string };
  try {
    wt = await ensureWorktree(repo, task);
  } catch (err) {
    return finish(db, task, null, { outcome: 'failed', reason: `worktree: ${(err as Error).message}` });
  }
  db.updateTask(task.id, { branch: wt.branch, worktree: wt.path });

  const logPath = join(LOG_DIR, `task-${task.id}-attempt-${task.attempts}.jsonl`);
  const log = createWriteStream(logPath, { flags: 'a' });
  const runId = db.startRun(task.id, task.attempts, logPath);
  const prompt = buildPrompt(
    task,
    db.runsForTask(task.id).filter((r) => r.id !== runId),
  );

  // Install dependencies before the agent starts: it isn't allowed to install them itself.
  if (repo.setup_cmd) {
    const setup = await runCommand(repo.setup_cmd, wt.path, SETUP_TIMEOUT_MS);
    log.write(JSON.stringify({ type: 'agentdeck_setup', cmd: repo.setup_cmd, passed: setup.passed, output: setup.output }) + '\n');
    if (!setup.passed) {
      await closeLog(log);
      pauseRepo(db, repo, `setup failed on task #${task.id}`);
      return finish(db, task, runId, { outcome: 'blocked', reason: `setup failed: ${lastLine(setup.output)}` });
    }
  }

  const { result, exitCode, rateLimitedUntil, cancelled } = await runClaude(db, {
    args: claudeArgs(task, effectiveTools(repo, wt.path), prompt),
    cwd: wt.path,
    log,
    env: { AGENTDECK_TASK_ID: String(task.id) },
    shouldCancel: () => db.getTask(task.id)?.status === 'cancel_requested',
    onSpawn: (pid) => db.setRunPid(runId, pid),
  });

  const usage = result?.usage ?? {};
  const runFields: Partial<Run> = {
    exit_code: exitCode,
    session_id: result?.session_id ?? null,
    num_turns: result?.num_turns ?? null,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: result?.total_cost_usd ?? 0,
    result_text: result?.result ?? null,
  };

  try {
    await commitLeftovers(wt.path, `agentdeck: uncommitted work from task ${task.id}\n\n${task.title}`);
  } catch (err) {
    log.write(JSON.stringify({ type: 'agentdeck_error', text: `commit leftovers: ${(err as Error).message}` }) + '\n');
  }

  let outcome: WorkerResult;
  if (cancelled) {
    outcome = { outcome: 'cancelled' };
  } else if (rateLimitedUntil) {
    const until = rateLimitedUntil;
    db.setSetting('rate_limited_until', String(until));
    outcome = { outcome: 'rate_limited', reason: `rate limited until ${new Date(until * 1000).toISOString()}` };
  } else if (!result || result.is_error || exitCode !== 0) {
    outcome = { outcome: 'failed', reason: result?.subtype ?? `claude exited with code ${exitCode}` };
  } else {
    const status = parseStatus(result.result);
    if (status.blocked) {
      outcome = { outcome: 'blocked', reason: status.reason ?? 'agent reported blocked' };
    } else if (repo.test_cmd) {
      const tests = await runCommand(repo.test_cmd, wt.path, TEST_TIMEOUT_MS);
      log.write(JSON.stringify({ type: 'agentdeck_tests', passed: tests.passed, output: tests.output }) + '\n');
      runFields.tests_passed = tests.passed ? 1 : 0;
      outcome = tests.passed ? { outcome: 'done' } : { outcome: 'failed', reason: 'tests failed' };
    } else {
      outcome = { outcome: 'done' };
    }
    if (outcome.outcome === 'done' && (await commitsAhead(wt.path, repo.base_branch)) === 0) {
      outcome = { outcome: 'blocked', reason: 'agent finished without changing anything' };
    }
  }

  await closeLog(log);
  // Refused tool uses mean the repo's tool rules don't fit its work: every further task would hit the same wall.
  const denials = result?.permission_denials ?? [];
  runFields.denials = denials.length;
  if (denials.length && (outcome.outcome === 'blocked' || outcome.outcome === 'failed')) {
    pauseRepo(db, repo, `permission refused on task #${task.id}: ${firstDenial(denials)}`);
  }
  return finish(db, task, runId, outcome, runFields);
}

/** Record the run and move the task to its next state (including retry). */
function finish(db: Db, task: Task, runId: number | null, res: WorkerResult, runFields: Partial<Run> = {}): WorkerResult {
  if (runId !== null) {
    db.finishRun(runId, {
      ...runFields,
      outcome: res.outcome,
      ...(res.reason && !runFields.result_text ? { result_text: res.reason } : {}),
    });
  }
  // If cancel was requested while the run was ending, the lifecycle makes every outcome end 'cancelled'.
  const reason = { reason: res.reason ?? null };
  switch (res.outcome) {
    case 'done':
    case 'blocked':
    case 'cancelled':
      db.applyEvent(task.id, { type: 'finish', outcome: res.outcome }, reason);
      break;
    case 'rate_limited':
      // Not the task's fault: give the attempt back and requeue.
      db.applyEvent(task.id, { type: 'rate_limited' });
      break;
    case 'failed':
      db.applyEvent(task.id, { type: 'finish', outcome: 'failed', retry: task.attempts < task.max_attempts }, reason);
      break;
  }

  // Tell a human about final outcomes (a failure that will be retried isn't final).
  const final = db.getTask(task.id)!;
  if (final.status === 'done' || final.status === 'blocked' || final.status === 'failed') {
    const repo = db.getRepo(task.repo_id)?.name ?? '';
    const body =
      final.status === 'done'
        ? `Ready to review on ${final.branch ?? 'its branch'}${repo ? ` in ${repo}` : ''}.`
        : `${final.blocked_reason ?? final.status}${repo ? ` (${repo})` : ''}`;
    notifyLater(db, { kind: final.status, title: `#${task.id} ${final.status}: ${task.title}`, body, task_id: task.id });
  }
  return res;
}
