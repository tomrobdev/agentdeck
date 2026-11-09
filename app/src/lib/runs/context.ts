// What a run was told and the files it touched, read from its log. Pure, so the dashboard's rules are tested from daemon/test.
import type { LogEntry } from '../../../../daemon/src/api/contract/files.ts';

export type PromptEntry = Extract<LogEntry, { kind: 'prompt' }>;

/** A file the run's Edit, MultiEdit and Write calls changed, with the lines of the edited text they removed and added. */
export interface TouchedFile {
  /** The path as the calls named it, uncut. */
  file: string;
  added: number;
  removed: number;
  /** How many calls changed it. */
  calls: number;
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write']);

/** What each claude of the run was told, in order: one prompt, or a resume's and then a fresh start's when the resume failed. */
export function promptsOf(entries: LogEntry[]): PromptEntry[] {
  return entries.filter((e): e is PromptEntry => e.kind === 'prompt');
}

/** The entries the transcript shows: all but the prompts, which show above it. */
export function withoutPrompts(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.kind !== 'prompt');
}

/**
 * The files the run's Edit, MultiEdit and Write calls touched, in the order it first touched them, a subagent's calls
 * included. A call whose result failed changed nothing and is left out. Counts are lines of the edited text summed over
 * the calls, not git's.
 */
export function filesTouched(entries: LogEntry[]): TouchedFile[] {
  const failed = new Set(entries.flatMap((e) => (e.kind === 'tool_result' && !e.ok ? [e.id] : [])));
  const files = new Map<string, TouchedFile>();
  for (const e of entries) {
    if (e.kind !== 'tool' || !EDITS.has(e.name) || !e.file || (e.id && failed.has(e.id))) continue;
    const f = files.get(e.file) ?? { file: e.file, added: 0, removed: 0, calls: 0 };
    f.added += e.change?.added ?? 0;
    f.removed += e.change?.removed ?? 0;
    f.calls++;
    files.set(e.file, f);
  }
  return [...files.values()];
}
