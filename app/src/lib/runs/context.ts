// What a run was told and the files it touched, read from its log. Pure, so the dashboard's rules are tested from daemon/test.
import type { LogEntry } from '../../../../daemon/src/api/contract/files.ts';

export type PromptEntry = Extract<LogEntry, { kind: 'prompt' }>;

export interface TouchedFile {
  file: string;
  added: number;
  removed: number;
  calls: number;
}

const EDITS = new Set(['Edit', 'MultiEdit', 'Write']);

export function promptsOf(entries: LogEntry[]): PromptEntry[] {
  return entries.filter((e): e is PromptEntry => e.kind === 'prompt');
}

export function withoutPrompts(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.kind !== 'prompt');
}

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
