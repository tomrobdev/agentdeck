// Adapter for pushing branches and managing pull requests with git and gh. Only the daemon calls these;
// agents cannot push. Tests replace the members of `github` to fake the network.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type MergeMethod, type PrDetails, parsePrDetails } from '../domain/pull-request/merge.ts';
import { type PrState, parsePrState } from '../domain/pull-request/pr.ts';
import { lastLine } from '../domain/text.ts';

const exec = promisify(execFile);

/**
 * A git command that talks to a remote. It must never wait for a person: the daemon runs without a
 * terminal, and a credential prompt would hold the task's slot forever. So prompts are off and it times out.
 */
async function gitRemote(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export interface CreatePr {
  cwd: string; // the task's worktree
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  labels?: string[];
}

/** The first line of a failed command's stderr (or message), for a one-line error. */
function failure(err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr?.trim() || e.message || String(err)).trim();
  return new Error(text.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 500));
}

/** Whether `gh` is logged in, and its last line of output to say why not. */
export function ghAuth(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 30_000 }, (err, stdout, stderr) => {
      const text = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: text ? lastLine(text) : (err?.message ?? '') });
    });
  });
}

export const github = {
  /** `git push -u origin <branch>` from the repo. Fails rather than prompting for credentials. */
  async push(repoPath: string, branch: string): Promise<void> {
    try {
      await gitRemote(repoPath, 120_000, 'push', '-u', 'origin', branch);
    } catch (err) {
      throw failure(err);
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
    try {
      const { stdout } = await exec('gh', args, { cwd: pr.cwd, timeout: 60_000 });
      const url = stdout.trim().split('\n').at(-1) ?? '';
      if (!url) throw new Error('gh printed no URL');
      return url;
    } catch (err) {
      throw failure(err);
    }
  },

  /** `gh label create --force`: make sure the repo has the label, so `gh pr create --label` can use it. */
  async ensureLabel(cwd: string, label: { name: string; description: string; color: string }): Promise<void> {
    try {
      await exec('gh', ['label', 'create', label.name, '--force', '--description', label.description, '--color', label.color], {
        cwd,
        timeout: 30_000,
      });
    } catch (err) {
      throw failure(err);
    }
  },

  /** `gh pr edit <url> --add-label` or `--remove-label`. */
  async setLabel(url: string, cwd: string, label: string, on: boolean): Promise<void> {
    try {
      await exec('gh', ['pr', 'edit', url, on ? '--add-label' : '--remove-label', label], { cwd, timeout: 30_000 });
    } catch (err) {
      throw failure(err);
    }
  },

  /** `gh pr close <url>`: closes the PR without merging; the branch stays. */
  async closePr(url: string, cwd: string): Promise<void> {
    try {
      await exec('gh', ['pr', 'close', url], { cwd, timeout: 30_000 });
    } catch (err) {
      throw failure(err);
    }
  },

  /** `gh pr view <url> --json state`. */
  async prState(url: string, cwd: string): Promise<PrState> {
    try {
      const { stdout } = await exec('gh', ['pr', 'view', url, '--json', 'state'], { cwd, timeout: 30_000 });
      const state = parsePrState(String(JSON.parse(stdout).state ?? ''));
      if (!state) throw new Error(`unexpected PR state in ${stdout.trim()}`);
      return state;
    } catch (err) {
      throw failure(err);
    }
  },

  /**
   * What `gh pr view` says about a PR that decides whether it can merge. The changed files' paths and the labels only
   * matter to auto-merge, and `files` grows with the PR, so they are read when `withFiles` asks.
   */
  async prDetails(url: string, cwd: string, opts: { withFiles?: boolean } = {}): Promise<PrDetails> {
    const fields = `isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup${opts.withFiles ? ',files,labels' : ''}`;
    try {
      const { stdout } = await exec('gh', ['pr', 'view', url, '--json', fields], { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      return parsePrDetails(stdout);
    } catch (err) {
      throw failure(err);
    }
  },

  /** `gh pr ready`: take a draft PR out of draft. */
  async markReady(url: string, cwd: string): Promise<void> {
    try {
      await exec('gh', ['pr', 'ready', url], { cwd, timeout: 30_000 });
    } catch (err) {
      throw failure(err);
    }
  },

  /**
   * `gh pr merge` with the given method. A squash gets `message` as its commit (subject and body).
   * The branch is left alone (`deleteRemoteBranch` removes it afterwards), since gh would
   * also try to delete the local branch, which the task's worktree has checked out.
   */
  async merge(pr: { url: string; cwd: string; method: MergeMethod; message?: { subject: string; body: string } }): Promise<void> {
    const message = pr.method === 'squash' && pr.message ? ['--subject', pr.message.subject, '--body', pr.message.body] : [];
    try {
      await exec('gh', ['pr', 'merge', pr.url, `--${pr.method}`, ...message], { cwd: pr.cwd, timeout: 60_000 });
    } catch (err) {
      throw failure(err);
    }
  },

  /** `git push origin --delete <branch>`. */
  async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    try {
      await gitRemote(repoPath, 60_000, 'push', 'origin', '--delete', branch);
    } catch (err) {
      throw failure(err);
    }
  },
};
