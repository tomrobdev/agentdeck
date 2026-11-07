// Run logs on disk: claude's stream-json lines plus the daemon's own `agentdeck_*` events.
import { type WriteStream, appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type LogEntry, parseLogLine } from '../domain/runs/translate/log.ts';

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

/** Write a run's Claude Code settings file (domain/runs/translate/sandbox.ts) next to its log. */
export function writeSettings(path: string, settings: object): void {
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

/** End a log stream and wait until it is on disk, so readers never see a finished run with a partial log. */
export function closeLog(log: WriteStream): Promise<void> {
  return new Promise((resolve) => log.end(() => resolve()));
}

/** Delete files; one already gone is fine. Returns the paths it couldn't remove, each with the reason. */
export function removeFiles(paths: string[]): string[] {
  const failed: string[] = [];
  for (const p of paths) {
    try {
      rmSync(p, { force: true, recursive: true });
    } catch (err) {
      failed.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed;
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(parseLogLine);
}
