// The Service port: the launchd service the daemon runs under, and what can be read of a daemon from outside. The real
// adapters are adapters/macos/service.ts, daemon-api.ts and daemon-log.ts (compose.ts).
import type { DaemonState } from '../../domain/operations/index.ts';

/** What launchd says about the service. */
export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
  plist: string;
  program: string;
}

/** The service's operations throw an Error with a message fit to print. */
export interface Service {
  status(): Promise<ServiceStatus>;
  start(): Promise<ServiceStatus>;
  stop(): Promise<void>;
  restart(): Promise<ServiceStatus>;
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  /** Print the daemon log's last lines to the terminal, and with `follow` keep printing. */
  tailLog(lines: number, follow: boolean): Promise<void>;
  /** A running daemon's state over its API, or null when nothing that speaks JSON answers on `port`. */
  daemonState(port: number): Promise<DaemonState | null>;
  /** The lines at the end of the daemon's log file, or null when there is none. */
  logTail(): string[] | null;
}
