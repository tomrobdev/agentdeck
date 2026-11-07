// Adapter for pushing branches and managing pull requests with git and gh. Only the daemon calls these;
// agents cannot push. Tests replace the members of `github` to fake the network.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type PrDetails, parsePrDetails } from '../domain/landing/merge.ts';
import type { MergeMethod } from '../domain/repos/repo.ts';
import { lastLine } from '../domain/shared/text.ts';
import { gitRemote } from './git.ts';

const exec = promisify(execFile);

/** How long a `gh` call may take unless it asks for more. */
const GH_TIMEOUT_MS = 30_000;
const LONG_GH_TIMEOUT_MS = 60_000;

export interface CreatePr {
  cwd: string; // the task's worktree
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  labels?: string[];
}

/**
 * The first lines of a failed command's stderr, for a one-line error. Never the error's own message: node quotes the
 * command line in it, and a PR's body is an argument.
 */
export function failure(err: unknown, tool = 'gh', timeoutMs = GH_TIMEOUT_MS): Error {
  const e = err as { stderr?: string; killed?: boolean; signal?: string | null; code?: unknown };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  if (e.killed) return new Error(`${tool} timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (stderr) return new Error(stderr.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 500));
  if (e.signal) return new Error(`${tool} was stopped by ${e.signal}`);
  return new Error(typeof e.code === 'number' ? `${tool} exited with code ${e.code}` : `${tool} failed`);
}

/** Run `gh` and return its stdout. The one place `gh` is called: every call times out, and a failure never quotes the arguments. */
async function gh(args: string[], opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const { cwd, timeoutMs = GH_TIMEOUT_MS, maxBuffer } = opts;
  try {
    const { stdout } = await exec('gh', args, { cwd, timeout: timeoutMs, maxBuffer });
    return stdout;
  } catch (err) {
    throw failure(err, 'gh', timeoutMs);
  }
}

export const github = {
  /** `gh auth status`: whether `gh` is logged in, and its last line of output to say why not. */
  async auth(): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec('gh', ['auth', 'status'], { timeout: GH_TIMEOUT_MS });
      const text = `${stdout}${stderr}`.trim();
      return { ok: true, output: text ? lastLine(text) : '' };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      const text = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
      return { ok: false, output: text ? lastLine(text) : failure(err).message };
    }
  },

  /** `git push -u origin <branch>` from the repo. Fails rather than prompting for credentials. */
  async push(repoPath: string, branch: string): Promise<void> {
    try {
      await gitRemote(repoPath, 120_000, 'push', '-u', 'origin', branch);
    } catch (err) {
      throw failure(err, 'git', 120_000);
    }
  },

  /** `gh pr create` in the worktree; returns the new PR's URL. */
  async createPr(pr: CreatePr): Promise<string> {
    const args = [
      'pr',
      'create',
      '--base',
      pr.base,
      '--head',
      pr.head,
      '--title',
      pr.title,
      ...(pr.draft ? ['--draft'] : []),
      ...(pr.labels ?? []).flatMap((label) => ['--label', label]),
      '--body',
      pr.body,
    ];
    const stdout = await gh(args, { cwd: pr.cwd, timeoutMs: LONG_GH_TIMEOUT_MS });
    const url = stdout.trim().split('\n').at(-1) ?? '';
    if (!url) throw new Error('gh printed no URL');
    return url;
  },

  /** `gh label create --force`: make sure the repo has the label, so `gh pr create --label` can use it. */
  async ensureLabel(cwd: string, label: { name: string; description: string; color: string }): Promise<void> {
    await gh(['label', 'create', label.name, '--force', '--description', label.description, '--color', label.color], { cwd });
  },

  /** `gh pr edit <url> --add-label` or `--remove-label`. */
  async setLabel(url: string, cwd: string, label: string, on: boolean): Promise<void> {
    await gh(['pr', 'edit', url, on ? '--add-label' : '--remove-label', label], { cwd });
  },

  /** `gh pr close <url>`: closes the PR without merging; the branch stays. */
  async closePr(url: string, cwd: string): Promise<void> {
    await gh(['pr', 'close', url], { cwd });
  },

  /**
   * What `gh pr view` says about a PR: its state, and what decides whether it can merge. The changed files' paths and the
   * labels only matter to auto-merge, and `files` grows with the PR, so they are read when `withFiles` asks.
   */
  async prDetails(url: string, cwd: string, opts: { withFiles?: boolean } = {}): Promise<PrDetails> {
    const fields = `state,headRefOid,isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup${opts.withFiles ? ',files,labels' : ''}`;
    return parsePrDetails(await gh(['pr', 'view', url, '--json', fields], { cwd, maxBuffer: 16 * 1024 * 1024 }));
  },

  /**
   * `gh run view <run-id> --log-failed`: the log of a GitHub Actions run's failed steps, each line prefixed with its job
   * and step. With `job`, only that job's (`--job`), so each failing check gets its own log.
   */
  async failedLog(cwd: string, run: string, job: string | null = null): Promise<string> {
    return gh(['run', 'view', run, ...(job ? ['--job', job] : []), '--log-failed'], {
      cwd,
      timeoutMs: LONG_GH_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  },

  /** `gh pr ready`: take a draft PR out of draft. */
  async markReady(url: string, cwd: string): Promise<void> {
    await gh(['pr', 'ready', url], { cwd });
  },

  /**
   * `gh pr merge` with the given method. A squash gets `message` as its commit (subject and body).
   * The branch is left alone (`deleteRemoteBranch` removes it afterwards), since gh would
   * also try to delete the local branch, which the task's worktree has checked out.
   */
  async merge(pr: { url: string; cwd: string; method: MergeMethod; message?: { subject: string; body: string } }): Promise<void> {
    const message = pr.method === 'squash' && pr.message ? ['--subject', pr.message.subject, '--body', pr.message.body] : [];
    await gh(['pr', 'merge', pr.url, `--${pr.method}`, ...message], { cwd: pr.cwd, timeoutMs: LONG_GH_TIMEOUT_MS });
  },

  /** `git push origin --delete <branch>`. */
  async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    try {
      await gitRemote(repoPath, 60_000, 'push', 'origin', '--delete', branch);
    } catch (err) {
      throw failure(err, 'git', 60_000);
    }
  },
};
