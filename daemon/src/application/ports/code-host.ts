// The CodeHost port: pull requests and the pushes that go with them. The real adapter is adapters/github.ts
// (compose.ts); tests use the in-memory fake in test/fakes.ts.
import type { CreatePr, PrDetails } from '../../domain/landing/index.ts';
import type { MergeMethod } from '../../domain/repos/index.ts';

export interface CodeHost {
  /** Whether the host's CLI is logged in, and its last line of output to say why not. */
  auth(): Promise<{ ok: boolean; output: string }>;
  /** Push a branch to origin. */
  push(repoPath: string, branch: string): Promise<void>;
  /** Open a pull request; returns its URL. */
  createPr(pr: CreatePr): Promise<string>;
  ensureLabel(cwd: string, label: { name: string; description: string; color: string }): Promise<void>;
  setLabel(url: string, cwd: string, label: string, on: boolean): Promise<void>;
  closePr(url: string, cwd: string): Promise<void>;
  prDetails(url: string, cwd: string, opts?: { withFiles?: boolean }): Promise<PrDetails>;
  /** The log of a checks run's failed steps, or of one check's with `check`. */
  failedLog(cwd: string, run: string, check?: string | null): Promise<string>;
  markReady(url: string, cwd: string): Promise<void>;
  /** Merge the PR only while its head is still `head`, the commit the merge was decided on; GitHub refuses it otherwise. */
  merge(pr: { url: string; cwd: string; method: MergeMethod; head: string; message?: { subject: string; body: string } }): Promise<void>;
  deleteRemoteBranch(repoPath: string, branch: string): Promise<void>;
}
