// Builds the App the use cases take, on the database and the real adapters: for the CLI (`cli.ts`), which also hands
// it to the daemon (`cli/daemon.ts` → `daemon.ts`). Tests build theirs in test/fixtures.ts. Each process builds one,
// so nothing here is module state.
import { findClaude, runClaude } from './adapters/claude.ts';
import { github } from './adapters/github.ts';
import type { Agent } from './application/ports/agent.ts';
import type { App, Ports } from './application/ports/app.ts';
import type { CodeHost } from './application/ports/code-host.ts';
import type { Workspace } from './application/ports/workspace.ts';
import { workspace } from './adapters/workspace.ts';
import { type Db, openDb } from './db/index.ts';

/**
 * The App the entry points are given: the use cases' App, plus the rest of what the database offers that the entry
 * points still call directly (`close`, and the store calls the strict-layers step replaces with use cases).
 */
export type ComposedApp = Db & App;

/** claude through `adapters/claude.ts`: every session in its own process group. */
export const realAgent = (): Agent => ({ run: (session) => runClaude(session), find: async () => findClaude() });

/** Pull requests through `adapters/github.ts`. Each call looks the member up on `github`, so a test can replace one. */
export const realCodeHost = (): CodeHost => ({
  auth: () => github.auth(),
  push: (repoPath, branch) => github.push(repoPath, branch),
  createPr: (pr) => github.createPr(pr),
  ensureLabel: (cwd, label) => github.ensureLabel(cwd, label),
  setLabel: (url, cwd, label, on) => github.setLabel(url, cwd, label, on),
  closePr: (url, cwd) => github.closePr(url, cwd),
  prDetails: (url, cwd, opts) => github.prDetails(url, cwd, opts),
  failedLog: (cwd, run, check) => github.failedLog(cwd, run, check),
  markReady: (url, cwd) => github.markReady(url, cwd),
  merge: (pr) => github.merge(pr),
  deleteRemoteBranch: (repoPath, branch) => github.deleteRemoteBranch(repoPath, branch),
});

/** Git, the shell and worktree files through `adapters/workspace.ts`. */
export const realWorkspace = (): Workspace => workspace;

/** The ports on the real adapters. */
export const realPorts = (): Ports => ({ agent: realAgent(), codeHost: realCodeHost(), workspace: realWorkspace() });

/** Open the database (the live one unless `path` names another) and build the App on it. */
export function composeApp(path?: string): ComposedApp {
  return Object.assign(openDb(path), realPorts());
}
