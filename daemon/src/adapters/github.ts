// Adapter for pushing branches and managing pull requests with git and gh. Only the daemon calls these;
// agents cannot push. Tests replace the members of `github` to fake the network.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type MergeMethod, type PrDetails, parsePrDetails } from '../domain/pull-request/merge.ts';
import { type PrState, parsePrState } from '../domain/pull-request/pr.ts';
import { gitRemote } from './git.ts';

const exec = promisify(execFile);

export interface CreatePr {
  cwd: string; // the task's worktree
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
}

/** The first line of a failed command's stderr (or message), for a one-line error. */
function failure(err: unknown): Error {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr?.trim() || e.message || String(err)).trim();
  return new Error(text.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 500));
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

  /** What `gh pr view` says about a PR that decides whether it can merge. */
  async prDetails(url: string, cwd: string): Promise<PrDetails> {
    const fields = 'isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup';
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
