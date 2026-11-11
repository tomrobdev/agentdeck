// The RunLog port: a run's log and settings files on disk.
import type { WriteStream } from 'node:fs';
import type { LogEntry } from '#domain/runs/index.ts';

export type LogEvent = { type: string } & Record<string, unknown>;

export interface RunLog {
  event(log: WriteStream, event: LogEvent): void;
  append(path: string, event: LogEvent): void;
  writeSettings(path: string, settings: object): void;
  close(log: WriteStream): Promise<void>;
  removeFiles(paths: string[]): string[];
  read(path: string): LogEntry[];
  events(path: string): unknown[];
}
