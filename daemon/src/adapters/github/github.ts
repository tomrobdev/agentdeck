// Adapter for pushing branches and managing pull requests with git and gh.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type BranchPr,
  type CreatePr,
  type JobStart,
  type JobStep,
  type PrDetails,
  parseAnnotations,
  parseBranchPrs,
  parseJobStart,
  parseJobSteps,
  parsePrDetails,
} from '#domain/landing/index.ts';
import type { MergeMethod } from '#domain/repos/index.ts';
import { lastLine } from '#domain/shared/index.ts';
import { gitRemote } from '#adapters/git/exec.ts';

const exec = promisify(execFile);

const GH_TIMEOUT_MS = 30_000;
const LONG_GH_TIMEOUT_MS = 60_000;

export function failure(err: unknown, tool = 'gh', timeoutMs = GH_TIMEOUT_MS): Error {
  const e = err as { stderr?: string; killed?: boolean; signal?: string | null; code?: unknown };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  if (e.killed) return new Error(`${tool} timed out after ${Math.round(timeoutMs / 1000)}s`);
  if (stderr) return new Error(stderr.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 500));
  if (e.signal) return new Error(`${tool} was stopped by ${e.signal}`);
  return new Error(typeof e.code === 'number' ? `${tool} exited with code ${e.code}` : `${tool} failed`);
}

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

  async push(repoPath: string, branch: string): Promise<void> {
    try {
      await gitRemote(repoPath, 120_000, 'push', '-u', 'origin', branch);
    } catch (err) {
      throw failure(err, 'git', 120_000);
    }
  },

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

  async prsForBranch(cwd: string, branch: string): Promise<BranchPr[]> {
    return parseBranchPrs(await gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,state'], { cwd }));
  },

  async ensureLabel(cwd: string, label: { name: string; description: string; color: string }): Promise<void> {
    await gh(['label', 'create', label.name, '--force', '--description', label.description, '--color', label.color], { cwd });
  },

  async setLabel(url: string, cwd: string, label: string, on: boolean): Promise<void> {
    await gh(['pr', 'edit', url, on ? '--add-label' : '--remove-label', label], { cwd });
  },

  async closePr(url: string, cwd: string): Promise<void> {
    await gh(['pr', 'close', url], { cwd });
  },

  async commentOnPr(url: string, cwd: string, body: string): Promise<void> {
    await gh(['pr', 'comment', url, '--body', body], { cwd });
  },

  async prDetails(url: string, cwd: string, opts: { withFiles?: boolean } = {}): Promise<PrDetails> {
    const fields = `state,headRefOid,isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup,mergeCommit${opts.withFiles ? ',files,labels,body' : ''}`;
    return parsePrDetails(await gh(['pr', 'view', url, '--json', fields], { cwd, maxBuffer: 16 * 1024 * 1024 }));
  },

  async failedLog(cwd: string, run: string, job: string | null = null): Promise<string> {
    return gh(['run', 'view', run, ...(job ? ['--job', job] : []), '--log-failed'], {
      cwd,
      timeoutMs: LONG_GH_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  },

  async jobSteps(cwd: string, job: string): Promise<JobStep[]> {
    return parseJobSteps(await gh(['api', `repos/{owner}/{repo}/actions/jobs/${job}`], { cwd }));
  },

  async jobStart(cwd: string, job: string): Promise<{ job: JobStart; annotations: string[] }> {
    const [start, annotations] = await Promise.all([
      gh(['api', `repos/{owner}/{repo}/actions/jobs/${job}`], { cwd }),
      gh(['api', `repos/{owner}/{repo}/check-runs/${job}/annotations`], { cwd }).catch(() => '[]'),
    ]);
    return { job: parseJobStart(start), annotations: parseAnnotations(annotations) };
  },

  async markReady(url: string, cwd: string): Promise<void> {
    await gh(['pr', 'ready', url], { cwd });
  },

  async merge(pr: {
    url: string;
    cwd: string;
    method: MergeMethod;
    head: string;
    message?: { subject: string; body: string };
  }): Promise<void> {
    const message = pr.method === 'squash' && pr.message ? ['--subject', pr.message.subject, '--body', pr.message.body] : [];
    await gh(['pr', 'merge', pr.url, `--${pr.method}`, '--match-head-commit', pr.head, ...message], {
      cwd: pr.cwd,
      timeoutMs: LONG_GH_TIMEOUT_MS,
    });
  },

  async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    try {
      await gitRemote(repoPath, 60_000, 'push', 'origin', '--delete', branch);
    } catch (err) {
      throw failure(err, 'git', 60_000);
    }
  },
};
