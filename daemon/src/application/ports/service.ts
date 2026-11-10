// The Service port: the launchd service the daemon runs under, and what can be read of a daemon from outside.
import type { DaemonState } from '../../domain/operations/index.ts';

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
  plist: string;
  program: string;
}

export interface Service {
  status(): Promise<ServiceStatus>;
  start(): Promise<ServiceStatus>;
  stop(): Promise<void>;
  restart(): Promise<ServiceStatus>;
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  tailLog(lines: number, follow: boolean): Promise<void>;
  daemonState(port: number): Promise<DaemonState | null>;
  logTail(): string[] | null;
}
