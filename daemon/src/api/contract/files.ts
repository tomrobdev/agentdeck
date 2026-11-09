// Work, a task's code: its changed files, the base's drift and the repo's files.
import type { ChangeStatus, FileRef, SinceKind, TaskStatus } from '../../domain/work/index.ts';
import type { TaskId } from '../../domain/shared/index.ts';

export interface ChangedFile {
  path: string;
  old_path: string | null;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  at: string;
  committed_at: string;
}

export interface SincePoint {
  kind: SinceKind;
  sha: string;
  attempt: number | null;
  at: string;
}

export interface Changes {
  base_ref: string;
  base: string;
  head: string;
  since: string | null;
  base_may_show: boolean;
  files: ChangedFile[];
  commits: Commit[];
  since_points: SincePoint[];
}

/** A path the prompt names that the base changed since the task was added, with the commits that changed it, newest first. */
export interface StalePath {
  path: string;
  commits: { sha: string; subject: string; at: string }[];
}

/** How far the base (`ref`, at commit `base`) moved since the task was added: `commits` on it, and the named paths they changed. */
export interface Staleness {
  ref: string;
  base: string;
  commits: number;
  changed: StalePath[];
}

/** Another open task in the repo whose named or changed paths meet this one's, and whether a link already joins them. */
export interface Overlap {
  id: TaskId;
  title: string;
  status: TaskStatus;
  paths: string[];
  linked: boolean;
}

/**
 * GET /api/tasks/:id/proposal-check: what to know before approving a proposed or queued task. Empty for any other
 * status; `staleness` is null when git can't say. `notes` are the named paths not on the base.
 */
export interface ProposalCheck {
  staleness: Staleness | null;
  notes: string[];
  overlaps: Overlap[];
}

export interface FilePatch {
  path: string;
  patch: string;
  truncated: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

export interface TreeListing {
  ref: FileRef;
  sha: string;
  path: string;
  entries: TreeEntry[];
}

export interface FileContent {
  path: string;
  ref: FileRef;
  sha: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

export interface LogChange {
  added: number;
  removed: number;
  old: string;
  new: string;
}

export type LogEntry = {
  /** The event's timestamp. */
  at?: string;
  /** The `tool_use` id of the subagent call this entry comes from. */
  parent?: string;
} & (
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id?: string; name: string; input: string; summary: string; file?: string; change?: LogChange }
  | { kind: 'tool_result'; id: string; ok: boolean; output: string; lines: number }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string }
);
