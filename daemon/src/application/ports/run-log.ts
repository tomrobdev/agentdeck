// The RunLog port: a run's log and settings files on disk. The real adapter is adapters/claude/run-log.ts (compose.ts); tests
// run it on real files in a temporary folder.
import type { WriteStream } from 'node:fs';
import type { LogEntry } from '../../domain/runs/index.ts';

/** One daemon event: its `type` and whatever it carries. */
export type LogEvent = { type: string } & Record<string, unknown>;

export interface RunLog {
  /** Append one daemon event to an open log stream. */
  event(log: WriteStream, event: LogEvent): void;
  /** Append one daemon event to a finished run's log file. Best effort. */
  append(path: string, event: LogEvent): void;
  /** Write a run's Claude Code settings file. */
  writeSettings(path: string, settings: object): void;
  /** End a log stream and wait until it is on disk. */
  close(log: WriteStream): Promise<void>;
  /** Delete files; one already gone is fine. The paths it couldn't remove, each with the reason. */
  removeFiles(paths: string[]): string[];
  /** A log's entries; none when the file is missing. */
  read(path: string): LogEntry[];
  /** A log's lines, parsed as JSON, skipping any that aren't; none when the file is missing. */
  events(path: string): unknown[];
}
