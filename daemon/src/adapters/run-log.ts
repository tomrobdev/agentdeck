// Run logs on disk: claude's stream-json lines plus the daemon's own `agentdeck_*` events.
import { type WriteStream, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { type LogEntry, parseLogLine } from '../domain/run/log.ts';

/** Append one daemon event to a log stream. */
export function writeEvent(log: WriteStream, event: { type: string } & Record<string, unknown>): void {
  log.write(JSON.stringify(event) + '\n');
}

/** Append one daemon event to a finished run's log file. Best effort: the log is a convenience. */
export function appendEvent(path: string, event: { type: string } & Record<string, unknown>): void {
  try {
    appendFileSync(path, JSON.stringify(event) + '\n');
  } catch {
    // the caller reports the event elsewhere too
  }
}

/** End a log stream and wait until it is on disk, so readers never see a finished run with a partial log. */
export function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve) => log.end(() => resolve()));
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(parseLogLine);
}
