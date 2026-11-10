// Protected edits: files a worker may not edit itself (under .claude/), which it writes out to the worktree's edits folder for the daemon to commit after the run.
import { AGENTDECK_FOLDER } from './repo.ts';

export const PROTECTED_PREFIXES = ['.claude/'];

export const NEVER_APPLIED = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/'];

export const EDITS_FOLDER = `${AGENTDECK_FOLDER}/edits`;

export const EDIT_LIMIT = 1024 * 1024;

export const isProtectedPath = (path: string): boolean => PROTECTED_PREFIXES.some((p) => path.startsWith(p));

export function editPathFor(target: string): string {
  return `${EDITS_FOLDER}/${isProtectedPath(target) ? target.replace(/^\./, '') : target}`;
}

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

export function protectedEditsMessage(paths: string[]): string {
  return `Apply protected edits: ${paths.join(', ')}`;
}
