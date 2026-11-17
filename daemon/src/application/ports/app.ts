// The one object every use case takes: the repositories and the other ports, built by the composition root (`src/compose.ts` for the daemon and the CLI, `test/fixtures/fixtures.ts` for tests).
import type { Agent } from '#application/ports/agent.ts';
import type { CodeHost } from '#application/ports/code-host.ts';
import type { Goals } from '#application/ports/goals.ts';
import type { Notifier } from '#application/ports/notifier.ts';
import type { Processes } from '#application/ports/processes.ts';
import type { Repositories } from '#application/ports/repositories/index.ts';
import type { RunLog } from '#application/ports/run-log.ts';
import type { Service } from '#application/ports/service.ts';
import type { Source } from '#application/ports/source.ts';
import type { Workspace } from '#application/ports/workspace.ts';

export interface Ports {
  agent: Agent;
  codeHost: CodeHost;
  workspace: Workspace;
  notifier: Notifier;
  runLog: RunLog;
  processes: Processes;
  service: Service;
  goals: Goals;
  source: Source;
}

export type App = Repositories & Ports;

export type ComposedApp = App & { close(): void };
