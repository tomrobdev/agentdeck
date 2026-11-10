// The one object every use case takes: the repositories and the other ports, built by the composition root (`src/compose.ts` for the daemon and the CLI, `test/fixtures/fixtures.ts` for tests).
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
