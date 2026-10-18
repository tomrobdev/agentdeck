// Adapter for pushing branches and managing pull requests with git and gh. Only the daemon calls these;
// agents cannot push. Tests replace the members of `github` to fake the network.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './git.ts';
import { parsePrState } from './domain/pr.ts';
import type { PrState } from './db.ts';

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
  /** `git push -u origin <branch>` from the repo. */
  async push(repoPath: string, branch: string): Promise<void> {
    try {
      await git(repoPath, 'push', '-u', 'origin', branch);
    } catch (err) {
      throw failure(err);
    }
  },

  /** `gh pr create` in the worktree; returns the new PR's URL. */
  async createPr(pr: CreatePr): Promise<string> {
    const args = ['pr', 'create', '--base', pr.base, '--head', pr.head, '--title', pr.title, ...(pr.draft ? ['--draft'] : []), '--body', pr.body];
    try {
      const { stdout } = await exec('gh', args, { cwd: pr.cwd, timeout: 60_000 });
      const url = stdout.trim().split('\n').at(-1) ?? '';
      if (!url) throw new Error('gh printed no URL');
      return url;
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
};
