// The CodeHost port: pull requests and the pushes that go with them.
import type { BranchPr, CreatePr, JobStep, PrDetails } from '../../domain/landing/index.ts';
import type { MergeMethod } from '../../domain/repos/index.ts';

export interface CodeHost {
  auth(): Promise<{ ok: boolean; output: string }>;
  push(repoPath: string, branch: string): Promise<void>;
  createPr(pr: CreatePr): Promise<string>;
  prsForBranch(cwd: string, branch: string): Promise<BranchPr[]>;
  ensureLabel(cwd: string, label: { name: string; description: string; color: string }): Promise<void>;
  setLabel(url: string, cwd: string, label: string, on: boolean): Promise<void>;
  closePr(url: string, cwd: string): Promise<void>;
  prDetails(url: string, cwd: string, opts?: { withFiles?: boolean }): Promise<PrDetails>;
  failedLog(cwd: string, run: string, check?: string | null): Promise<string>;
  jobSteps(cwd: string, job: string): Promise<JobStep[]>;
  markReady(url: string, cwd: string): Promise<void>;
  merge(pr: { url: string; cwd: string; method: MergeMethod; head: string; message?: { subject: string; body: string } }): Promise<void>;
  deleteRemoteBranch(repoPath: string, branch: string): Promise<void>;
}
