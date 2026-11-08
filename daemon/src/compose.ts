// Builds the App the use cases take, on the database and the real adapters: for the CLI (`cli.ts`), which also hands
// it to the daemon (`cli/daemon.ts` → `daemon.ts`). Tests build theirs in test/fixtures.ts. Each process builds one,
// so nothing here is module state.
import { findClaude, runClaude } from './adapters/claude.ts';
import { KeepAwake } from './adapters/caffeinate.ts';
import { fetchDaemonState } from './adapters/daemon-api.ts';
import { readLogTail } from './adapters/daemon-log.ts';
import { github } from './adapters/github.ts';
import { deleteGoals, goalsPath, readGoals, writeGoals } from './adapters/goals.ts';
import { desktop, ntfy } from './adapters/notify.ts';
import { activeChildren, killGroup, ownsLiveGroup, reapOrphans } from './adapters/processes.ts';
import { appendEvent, closeLog, readLog, removeFiles, writeEvent, writeSettings } from './adapters/run-log.ts';
import { DAEMON_LOG, install, restart, serviceStatus, start, stop, tailLog, uninstall } from './adapters/service.ts';
import type { Agent } from './application/ports/agent.ts';
import type { App, Ports } from './application/ports/app.ts';
import type { CodeHost } from './application/ports/code-host.ts';
import type { Goals } from './application/ports/goals.ts';
import type { Notifier } from './application/ports/notifier.ts';
import type { Processes } from './application/ports/processes.ts';
import type { RunLog } from './application/ports/run-log.ts';
import type { Service } from './application/ports/service.ts';
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

/** Desktop and ntfy notifications through `adapters/notify.ts`. */
export const realNotifier = (): Notifier => ({ desktop, ntfy });

/** Run log and settings files through `adapters/run-log.ts`. */
export const realRunLog = (): RunLog => ({
  event: writeEvent,
  append: appendEvent,
  writeSettings,
  close: closeLog,
  removeFiles,
  read: readLog,
});

/** Process groups through `adapters/processes.ts`, keep-awake through `adapters/caffeinate.ts`. */
export const realProcesses = (): Processes => ({
  stopAll: () => {
    for (const child of activeChildren) killGroup(child.pid);
  },
  reapOrphans,
  ownsLiveGroup,
  keepAwake: (enabled) => new KeepAwake(enabled),
});

/** The launchd service through `adapters/service.ts`, a daemon's API and log through `daemon-api.ts` and `daemon-log.ts`. */
export const realService = (): Service => ({
  status: serviceStatus,
  start,
  stop,
  restart,
  install,
  uninstall,
  tailLog,
  daemonState: (port) => fetchDaemonState(port),
  logTail: () => readLogTail(DAEMON_LOG),
});

/** Goals files through `adapters/goals.ts`. */
export const realGoals = (): Goals => ({ path: goalsPath, read: readGoals, write: writeGoals, delete: deleteGoals });

/** The ports on the real adapters. */
export const realPorts = (): Ports => ({
  agent: realAgent(),
  codeHost: realCodeHost(),
  workspace: realWorkspace(),
  notifier: realNotifier(),
  runLog: realRunLog(),
  processes: realProcesses(),
  service: realService(),
  goals: realGoals(),
});

/** Open the database (the live one unless `path` names another) and build the App on it. */
export function composeApp(path?: string): ComposedApp {
  return Object.assign(openDb(path), realPorts());
}
