// The one object every use case takes: the repositories and the other ports, built by the composition root
// (`src/compose.ts` for the daemon and the CLI, `test/fixtures.ts` for tests). Use cases keep no state of their own:
// what they need arrives on `app`.
import type { Agent } from './agent.ts';
import type { CodeHost } from './code-host.ts';
import type { Repositories } from './repositories.ts';
import type { Workspace } from './workspace.ts';

/**
 * The ports besides the repositories, each an interface application/ owns. Agent, CodeHost and Workspace so far; the
 * rest join here one at a time, and the use cases that still import their adapters move onto them.
 */
export interface Ports {
  /** Runs claude sessions. */
  agent: Agent;
  /** Pull requests and pushes. */
  codeHost: CodeHost;
  /** Git, the shell and a worktree's files. */
  workspace: Workspace;
}

/** What the use cases take: the repositories and the ports, one object. */
export type App = Repositories & Ports;
