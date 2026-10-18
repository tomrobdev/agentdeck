import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ALWAYS_DISALLOWED_TOOLS,
  DEFAULT_ALLOWED_TOOLS,
  LOG_DIR,
  WORKER_SYSTEM_PROMPT,
  claudeBin,
  ensureDirs,
} from './config.ts';
import type { Db, Repo, Run, Task } from './db.ts';
import { commitLeftovers, commitsAhead, ensureWorktree } from './git.ts';
import { notifyLater } from './notify.ts';

export type Outcome = 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';

export interface WorkerResult {
  outcome: Outcome;
  reason?: string;
}

interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  api_error_status?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Live claude processes, so the daemon can stop them on shutdown. */
export const activeChildren = new Set<ChildProcess>();

const TEST_TIMEOUT_MS = 15 * 60_000;
const CANCEL_POLL_MS = 2_000;

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

export function claudeArgs(task: Task, repo: Repo, prompt: string): string[] {
  const allowed: string[] = repo.allowed_tools ? JSON.parse(repo.allowed_tools) : DEFAULT_ALLOWED_TOOLS;
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

function runTests(cmd: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { cwd, timeout: TEST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ passed: !err, output: `${stdout}${stderr}`.slice(-20_000) });
    });
  });
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
  const prompt = buildPrompt(task, db.runsForTask(task.id).filter((r) => r.id !== runId));

  const child = spawn(claudeBin(), claudeArgs(task, repo, prompt), {
    cwd: wt.path,
    env: { ...process.env, AGENTDECK_TASK_ID: String(task.id) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);

  let result: ClaudeResult | undefined;
  let rateLimitedUntil: number | undefined;
  let cancelled = false;

  const cancelTimer = setInterval(() => {
    if (db.getTask(task.id)?.status === 'cancel_requested' && !cancelled) {
      cancelled = true;
      child.kill('SIGTERM');
    }
  }, CANCEL_POLL_MS);

  createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(line + '\n');
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'result') result = ev;
    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {};
      for (const [window, w] of Object.entries<any>(info.unifiedWindows ?? {})) {
        db.recordUsageWindow(window, w.utilization ?? 0, w.resetsAt ?? 0, info.status ?? null);
      }
      if (info.status === 'rejected') rateLimitedUntil = info.resetsAt;
    }
  });
  child.stderr.on('data', (d: Buffer) => log.write(JSON.stringify({ type: 'agentdeck_stderr', text: d.toString() }) + '\n'));

  const exitCode: number = await new Promise((resolve) => {
    child.on('error', (err) => {
      log.write(JSON.stringify({ type: 'agentdeck_error', text: err.message }) + '\n');
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
  clearInterval(cancelTimer);
  activeChildren.delete(child);

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
  } else if (rateLimitedUntil || result?.api_error_status === 429) {
    const until = rateLimitedUntil ?? Math.floor(Date.now() / 1000) + 15 * 60;
    db.setSetting('rate_limited_until', String(until));
    outcome = { outcome: 'rate_limited', reason: `rate limited until ${new Date(until * 1000).toISOString()}` };
  } else if (!result || result.is_error || exitCode !== 0) {
    outcome = { outcome: 'failed', reason: result?.subtype ?? `claude exited with code ${exitCode}` };
  } else {
    const status = parseStatus(result.result);
    if (status.blocked) {
      outcome = { outcome: 'blocked', reason: status.reason ?? 'agent reported blocked' };
    } else if (repo.test_cmd) {
      const tests = await runTests(repo.test_cmd, wt.path);
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

  log.end();
  return finish(db, task, runId, outcome, runFields);
}

/** Record the run and move the task to its next state (including retry). */
function finish(db: Db, task: Task, runId: number | null, res: WorkerResult, runFields: Partial<Run> = {}): WorkerResult {
  if (runId !== null) {
    db.finishRun(runId, { ...runFields, outcome: res.outcome, ...(res.reason && !runFields.result_text ? { result_text: res.reason } : {}) });
  }
  switch (res.outcome) {
    case 'done':
      db.updateTask(task.id, { status: 'done', blocked_reason: null });
      break;
    case 'blocked':
      db.updateTask(task.id, { status: 'blocked', blocked_reason: res.reason ?? null });
      break;
    case 'cancelled':
      db.updateTask(task.id, { status: 'cancelled' });
      break;
    case 'rate_limited':
      // Not the task's fault: give the attempt back and requeue.
      db.raw.prepare("UPDATE tasks SET status = 'queued', attempts = MAX(attempts - 1, 0), updated_at = datetime('now') WHERE id = ?").run(task.id);
      break;
    case 'failed':
      db.updateTask(task.id, {
        status: task.attempts < task.max_attempts ? 'queued' : 'failed',
        blocked_reason: res.reason ?? null,
      });
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
