// Builds the App the use cases take, on the database and the real adapters: for the CLI (`cli.ts`), which also hands
// it to the daemon (`cli/operations/daemon.ts` → `daemon.ts`). Tests build theirs in test/fixtures.ts. Each process builds one,
// so nothing here is module state.
import { findClaude, runClaude } from './adapters/claude/claude.ts';
import { KeepAwake } from './adapters/macos/caffeinate.ts';
import { fetchDaemonState } from './adapters/local/daemon-api.ts';
import { readLogTail } from './adapters/local/daemon-log.ts';
import { github } from './adapters/github/github.ts';
import { deleteGoals, goalsPath, readGoals, writeGoals } from './adapters/local/goals.ts';
import { desktop, ntfy } from './adapters/macos/notify.ts';
import { activeChildren, killGroup, ownsLiveGroup, reapOrphans } from './adapters/process/processes.ts';
import { appendEvent, closeLog, readEvents, readLog, removeFiles, writeEvent, writeSettings } from './adapters/claude/run-log.ts';
import { DAEMON_LOG, install, restart, serviceStatus, start, stop, tailLog, uninstall } from './adapters/macos/service.ts';
import type { Agent } from './application/ports/agent.ts';
import type { ComposedApp, Ports } from './application/ports/app.ts';
import type { CodeHost } from './application/ports/code-host.ts';
import type { Goals } from './application/ports/goals.ts';
import type { Notifier } from './application/ports/notifier.ts';
import type { Processes } from './application/ports/processes.ts';
import type { RunLog } from './application/ports/run-log.ts';
import type { Service } from './application/ports/service.ts';
import type { Source } from './application/ports/source.ts';
import { checkedOutBranch, checkoutCommit, hasUncommittedChanges } from './adapters/git/refs.ts';
import { watchSource } from './adapters/macos/watch.ts';
import type { Workspace } from './application/ports/workspace.ts';
import { workspace } from './adapters/git/workspace.ts';
import { openDb } from './db/index.ts';

/** claude through `adapters/claude/claude.ts`: every session in its own process group. */
export const realAgent = (): Agent => ({ run: (session) => runClaude(session), find: async () => findClaude() });

/** Pull requests through `adapters/github/github.ts`. Each call looks the member up on `github`, so a test can replace one. */
export const realCodeHost = (): CodeHost => ({
  auth: () => github.auth(),
  push: (repoPath, branch) => github.push(repoPath, branch),
  createPr: (pr) => github.createPr(pr),
  prsForBranch: (cwd, branch) => github.prsForBranch(cwd, branch),
  ensureLabel: (cwd, label) => github.ensureLabel(cwd, label),
  setLabel: (url, cwd, label, on) => github.setLabel(url, cwd, label, on),
  closePr: (url, cwd) => github.closePr(url, cwd),
  prDetails: (url, cwd, opts) => github.prDetails(url, cwd, opts),
  failedLog: (cwd, run, check) => github.failedLog(cwd, run, check),
  jobSteps: (cwd, job) => github.jobSteps(cwd, job),
  markReady: (url, cwd) => github.markReady(url, cwd),
  merge: (pr) => github.merge(pr),
  deleteRemoteBranch: (repoPath, branch) => github.deleteRemoteBranch(repoPath, branch),
});

/** Git, the shell and worktree files through `adapters/git/workspace.ts`. */
export const realWorkspace = (): Workspace => workspace;

/** Desktop and ntfy notifications through `adapters/macos/notify.ts`. */
export const realNotifier = (): Notifier => ({ desktop, ntfy });

/** Run log and settings files through `adapters/claude/run-log.ts`. */
export const realRunLog = (): RunLog => ({
  event: writeEvent,
  append: appendEvent,
  writeSettings,
  close: closeLog,
  removeFiles,
  read: readLog,
  events: readEvents,
});

/** Process groups through `adapters/process/processes.ts`, keep-awake through `adapters/macos/caffeinate.ts`. */
export const realProcesses = (): Processes => ({
  stopAll: () => {
    for (const child of activeChildren) killGroup(child.pid);
  },
  reapOrphans,
  ownsLiveGroup,
  keepAwake: (enabled) => new KeepAwake(enabled),
});

/** The launchd service through `adapters/macos/service.ts`, a daemon's API and log through `daemon-api.ts` and `daemon-log.ts`. */
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

/** Goals files through `adapters/local/goals.ts`. */
export const realGoals = (): Goals => ({ path: goalsPath, read: readGoals, write: writeGoals, delete: deleteGoals });

/** The daemon's source checkout through `adapters/git.ts` and `adapters/macos/watch.ts`. */
export const realSource = (): Source => ({
  commit: checkoutCommit,
  branch: checkedOutBranch,
  dirty: hasUncommittedChanges,
  watch: watchSource,
});

/** The ports on the real adapters. */
export const realPorts = (): Ports => ({
  source: realSource(),
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
