// Builds the App the use cases take, on the database and the real adapters: for the CLI (`cli.ts`), which also hands it to the daemon (`cli/operations/daemon.ts` → `daemon.ts`).
import { findClaude, runClaude } from '#adapters/claude/claude.ts';
import { KeepAwake } from '#adapters/macos/caffeinate.ts';
import { fetchDaemonState } from '#adapters/local/daemon-api.ts';
import { readLogTail } from '#adapters/local/daemon-log.ts';
import { github } from '#adapters/github/github.ts';
import { deleteGoals, goalsPath, readGoals, writeGoals } from '#adapters/local/goals.ts';
import { desktop, ntfy } from '#adapters/macos/notify.ts';
import { activeChildren, killGroup, ownsLiveGroup, reapOrphans } from '#adapters/process/processes.ts';
import { appendEvent, closeLog, readEvents, readLog, removeFiles, writeEvent, writeSettings } from '#adapters/claude/run-log.ts';
import { DAEMON_LOG, install, restart, serviceStatus, start, stop, tailLog, uninstall } from '#adapters/macos/service.ts';
import type { Agent } from '#application/ports/agent.ts';
import type { ComposedApp, Ports } from '#application/ports/app.ts';
import type { CodeHost } from '#application/ports/code-host.ts';
import type { Goals } from '#application/ports/goals.ts';
import type { Notifier } from '#application/ports/notifier.ts';
import type { Processes } from '#application/ports/processes.ts';
import type { RunLog } from '#application/ports/run-log.ts';
import type { Service } from '#application/ports/service.ts';
import type { IssueHost } from '#application/ports/issues.ts';
import { githubIssues } from '#adapters/github/issues.ts';
import type { Source } from '#application/ports/source.ts';
import { checkedOutBranch, checkoutCommit, hasUncommittedChanges } from '#adapters/git/refs.ts';
import { watchSource } from '#adapters/macos/watch.ts';
import type { Workspace } from '#application/ports/workspace.ts';
import { workspace } from '#adapters/git/workspace.ts';
import { openDb } from '#db/index.ts';

export const realAgent = (): Agent => ({ run: (session) => runClaude(session), find: async () => findClaude() });

export const realIssueHost = (): IssueHost => ({
  whoami: (cwd) => githubIssues.whoami(cwd),
  openIssues: (cwd, label) => githubIssues.openIssues(cwd, label),
  issue: (cwd, number) => githubIssues.issue(cwd, number),
  comments: (cwd, number) => githubIssues.comments(cwd, number),
  labelledBy: (cwd, number, label) => githubIssues.labelledBy(cwd, number, label),
  comment: (cwd, number, body) => githubIssues.comment(cwd, number, body),
  editLabels: (cwd, number, change) => githubIssues.editLabels(cwd, number, change),
  close: (cwd, number, reason, comment) => githubIssues.close(cwd, number, reason, comment),
});

export const realCodeHost = (): CodeHost => ({
  auth: () => github.auth(),
  push: (repoPath, branch) => github.push(repoPath, branch),
  createPr: (pr) => github.createPr(pr),
  prsForBranch: (cwd, branch) => github.prsForBranch(cwd, branch),
  ensureLabel: (cwd, label) => github.ensureLabel(cwd, label),
  setLabel: (url, cwd, label, on) => github.setLabel(url, cwd, label, on),
  closePr: (url, cwd) => github.closePr(url, cwd),
  commentOnPr: (url, cwd, body) => github.commentOnPr(url, cwd, body),
  prDetails: (url, cwd, opts) => github.prDetails(url, cwd, opts),
  failedLog: (cwd, run, check) => github.failedLog(cwd, run, check),
  jobSteps: (cwd, job) => github.jobSteps(cwd, job),
  jobStart: (cwd, job) => github.jobStart(cwd, job),
  markReady: (url, cwd) => github.markReady(url, cwd),
  merge: (pr) => github.merge(pr),
  deleteRemoteBranch: (repoPath, branch) => github.deleteRemoteBranch(repoPath, branch),
});

export const realWorkspace = (): Workspace => workspace;

export const realNotifier = (): Notifier => ({ desktop, ntfy });

export const realRunLog = (): RunLog => ({
  event: writeEvent,
  append: appendEvent,
  writeSettings,
  close: closeLog,
  removeFiles,
  read: readLog,
  events: readEvents,
});

export const realProcesses = (): Processes => ({
  stopAll: () => {
    for (const child of activeChildren) killGroup(child.pid);
  },
  reapOrphans,
  ownsLiveGroup,
  keepAwake: (enabled) => new KeepAwake(enabled),
});

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

export const realGoals = (): Goals => ({ path: goalsPath, read: readGoals, write: writeGoals, delete: deleteGoals });

export const realSource = (): Source => ({
  commit: checkoutCommit,
  branch: checkedOutBranch,
  dirty: hasUncommittedChanges,
  watch: watchSource,
});

export const realPorts = (): Ports => ({
  source: realSource(),
  agent: realAgent(),
  codeHost: realCodeHost(),
  issues: realIssueHost(),
  workspace: realWorkspace(),
  notifier: realNotifier(),
  runLog: realRunLog(),
  processes: realProcesses(),
  service: realService(),
  goals: realGoals(),
});

export function composeApp(path?: string): ComposedApp {
  return Object.assign(openDb(path), realPorts());
}
