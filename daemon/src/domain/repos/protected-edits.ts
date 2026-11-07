// Protected edits: files a worker may not edit itself (under .claude/), which it writes out to the worktree's edits
// folder for the daemon to commit after the run. A person still reviews them: a PR touching a protected path is never
// auto-merged (domain/landing/auto-merge.ts). Pure: no I/O.
import { PLAN_FOLDER } from '../work/plan.ts';

/** The path prefixes a worker may not edit. Their files instruct every later agent, so a person merges them. */
export const PROTECTED_PREFIXES = ['.claude/'];

/**
 * Protected paths the daemon never applies: Claude Code reads them when it starts, and hooks run outside the sandbox,
 * so a worker's version would take effect on the next run in the worktree before any person saw it. A worker still
 * blocks with `NEEDS edit` for these.
 */
export const NEVER_APPLIED = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/'];

/** The folder in a task's worktree where a worker writes protected edits. Git ignores it (it is in PLAN_FOLDER). */
export const EDITS_FOLDER = `${PLAN_FOLDER}/edits`;

/** A protected edit bigger than this is refused: these are skills and docs, not data. */
export const EDIT_LIMIT = 1024 * 1024;

/** Whether `path` (from the repo root) is under a protected prefix. */
export const isProtectedPath = (path: string): boolean => PROTECTED_PREFIXES.some((p) => path.startsWith(p));

/**
 * Where a worker writes the new version of protected file `target`: in the edits folder, with the leading dot of the
 * protected folder dropped (`.claude/x` → `.agentdeck/edits/claude/x`), because Claude Code refuses to write any path
 * with a `.claude` folder in it, wherever it is.
 */
export function editPathFor(target: string): string {
  return `${EDITS_FOLDER}/${isProtectedPath(target) ? target.replace(/^\./, '') : target}`;
}

/**
 * The file in the worktree that an edit at `relPath` (its path inside the edits folder) replaces, or why it is refused.
 * The protected folder may be spelled with or without its dot (`claude/x` or `.claude/x`, see `editPathFor`). Refused:
 * absolute paths, `..`, `.` or empty segments, backslashes, anything outside PROTECTED_PREFIXES, and NEVER_APPLIED.
 */
export function protectedEditTarget(relPath: string): { target: string } | { refused: string } {
  if (!relPath) return { refused: 'empty path' };
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return { refused: 'absolute path' };
  if (relPath.includes('\\')) return { refused: 'backslash in path' };
  const segments = relPath.split('/');
  if (segments.includes('..')) return { refused: 'path leaves the edits folder (..)' };
  if (segments.some((s) => s === '' || s === '.')) return { refused: 'empty or "." segment in path' };
  const undotted = PROTECTED_PREFIXES.some((p) => p.startsWith('.') && relPath.startsWith(p.slice(1)));
  const target = undotted ? `.${relPath}` : relPath;
  if (!isProtectedPath(target)) return { refused: `not under ${PROTECTED_PREFIXES.join(', ')}` };
  if (NEVER_APPLIED.some((p) => (p.endsWith('/') ? target.startsWith(p) : target === p))) {
    return { refused: 'settings and hooks are never applied: a person edits them' };
  }
  return { target };
}

/** The commit message of the commit that applies protected edits. */
export function protectedEditsMessage(paths: string[]): string {
  return `Apply protected edits: ${paths.join(', ')}`;
}
