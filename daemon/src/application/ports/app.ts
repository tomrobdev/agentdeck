// The one object every use case takes: the repositories and the other ports, built by the composition root
// (`src/compose.ts` for the daemon and the CLI, `test/fixtures.ts` for tests). Use cases keep no state of their own:
// what they need arrives on `app`.
import type { Agent } from './agent.ts';
import type { CodeHost } from './code-host.ts';
import type { Goals } from './goals.ts';
import type { Notifier } from './notifier.ts';
import type { Processes } from './processes.ts';
import type { Repositories } from './repositories/index.ts';
import type { RunLog } from './run-log.ts';
import type { Service } from './service.ts';
import type { Source } from './source.ts';
import type { Workspace } from './workspace.ts';

/** The ports besides the repositories, each an interface application/ owns. */
export interface Ports {
  /** Runs claude sessions. */
  agent: Agent;
  /** Pull requests and pushes. */
  codeHost: CodeHost;
  /** Git, the shell and a worktree's files. */
  workspace: Workspace;
  /** Desktop and ntfy notifications. */
  notifier: Notifier;
  /** Run logs and settings files. */
  runLog: RunLog;
  /** The claude process groups, and keeping the Mac awake. */
  processes: Processes;
  /** The launchd service and what can be read of a daemon from outside. */
  service: Service;
  /** Each repo's goals file. */
  goals: Goals;
  /** The daemon's own source checkout: its commit, branch and changes. */
  source: Source;
}

/** What the use cases take: the repositories and the ports, one object. */
export type App = Repositories & Ports;

/** The App an entry point is given: it also closes the database when the process is done. */
export type ComposedApp = App & { close(): void };
