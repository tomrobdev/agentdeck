// Reading a task's code from git: the shapes the API returns, path checks, size limits and the
// parsing of git's -z output. Pure: no I/O. The git calls are in adapters/git.ts.
import { sqliteUtc } from '../../shared/index.ts';

/** Which commit a read is at: the task's branch, or where it left the repo's base branch. */
export type FileRef = 'head' | 'base';
export const FILE_REFS: FileRef[] = ['head', 'base'];

export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface ChangedFile {
  path: string;
  old_path: string | null; // set for renames
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  at: string; // ISO 8601, the author date
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null; // bytes, for files
}

export interface Changes {
  base_ref: string; // the base branch ref the merge base was taken with, e.g. main or origin/main
  base: string;
  head: string;
  files: ChangedFile[];
  commits: Commit[]; // newest first
}

export interface FilePatch {
  path: string;
  patch: string;
  truncated: boolean;
}

export interface Tree {
  ref: FileRef;
  sha: string; // the commit
  path: string; // the folder, '' for the root
  entries: TreeEntry[];
}

export interface FileContent {
  path: string;
  ref: FileRef;
  sha: string; // the commit
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null; // null when binary
}

export const PATCH_LIMIT = 256 * 1024;
export const TEXT_LIMIT = 512 * 1024;
/** Like git, a file is binary if a NUL byte shows up this early. */
export const BINARY_SNIFF = 8000;

export type PathCheck = { ok: true; path: string } | { ok: false; error: string };

/**
 * A repo-relative path from a client, checked before it reaches git: no absolute paths, no `..`,
 * no NUL, nothing git could read as an option. Trailing slashes are dropped. The empty path (the
 * repo root) is allowed only with `allowRoot`.
 */
export function checkPath(input: string | null | undefined, opts: { allowRoot?: boolean } = {}): PathCheck {
  const raw = input ?? '';
  if (raw.includes('\0')) return { ok: false, error: 'path contains a NUL byte' };
  if (raw.startsWith('/')) return { ok: false, error: 'path must be relative to the repo' };
  if (raw.startsWith('-')) return { ok: false, error: 'path must not start with -' };
  const path = raw.replace(/\/+$/, '');
  if (!path) return opts.allowRoot ? { ok: true, path: '' } : { ok: false, error: 'path is required' };
  const parts = path.split('/');
  if (parts.includes('..')) return { ok: false, error: 'path must not contain ..' };
  if (parts.some((p) => p === '' || p === '.')) return { ok: false, error: 'path has an empty or . segment' };
  return { ok: true, path };
}

/** Whether these bytes look binary: a NUL byte in the first BINARY_SNIFF bytes. */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Cut `bytes` to at most `limit`, on a UTF-8 character boundary, and at the last newline when
 * `wholeLines` (so a patch keeps whole lines). Returns the text and whether anything was cut.
 */
export function capText(bytes: Uint8Array, limit: number, opts: { wholeLines?: boolean } = {}): { text: string; truncated: boolean } {
  if (bytes.length <= limit) return { text: new TextDecoder().decode(bytes), truncated: false };
  let end = limit;
  // Back up over continuation bytes (10xxxxxx) so a character isn't split.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  if (opts.wholeLines) {
    const nl = bytes.lastIndexOf(0x0a, end - 1);
    if (nl >= 0) end = nl + 1;
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

const tokens = (z: string): string[] => {
  const parts = z.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
};

/** `git diff --numstat -z` output. Binary files show `-` counts. A rename is `a\td\t\0old\0new\0`. */
export function parseNumstat(
  z: string,
): { path: string; old_path: string | null; additions: number; deletions: number; binary: boolean }[] {
  const out = [];
  const t = tokens(z);
  for (let i = 0; i < t.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t[i]);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    let path = m[3];
    let old_path: string | null = null;
    if (path === '') {
      old_path = t[++i];
      path = t[++i];
    }
    out.push({ path, old_path, additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

/** `git diff --name-status -z` output: `M\0path\0`, or `R087\0old\0new\0` for a rename (and copy). */
export function parseNameStatus(z: string): { status: ChangeStatus; path: string; old_path: string | null }[] {
  const out: { status: ChangeStatus; path: string; old_path: string | null }[] = [];
  const t = tokens(z);
  for (let i = 0; i < t.length; i++) {
    const code = t[i][0];
    if (code === 'R' || code === 'C') {
      const old_path = t[++i];
      const path = t[++i];
      out.push({ status: code === 'R' ? 'R' : 'A', path, old_path: code === 'R' ? old_path : null });
    } else {
      const path = t[++i];
      // T (type change) and anything unexpected read as a modification.
      out.push({ status: code === 'A' || code === 'D' ? code : 'M', path, old_path: null });
    }
  }
  return out;
}

/** Join name-status (what happened) with numstat (how much), by path, in git's order. */
export function mergeChanges(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = new Map(parseNumstat(numstat).map((n) => [n.path, n]));
  return parseNameStatus(nameStatus).map((s) => {
    const n = counts.get(s.path);
    return {
      path: s.path,
      old_path: s.old_path,
      status: s.status,
      additions: n?.additions ?? 0,
      deletions: n?.deletions ?? 0,
      binary: n?.binary ?? false,
    };
  });
}

/** Separators for `git log --format`: unit (field) and record. */
export const LOG_FORMAT = '%H%x1f%s%x1f%an%x1f%aI%x1e';

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, subject, author, iso] = r.split('\x1f');
      return { sha, subject, author, at: sqliteUtc(iso) };
    });
}

/**
 * `git ls-tree -l -z` output: `<mode> <type> <object> <size>\t<path>\0`, size `-` for trees.
 * Submodules (type commit) are left out: their contents aren't in this repo.
 */
export function parseLsTree(z: string): { type: 'blob' | 'tree'; object: string; size: number | null; path: string }[] {
  const out: { type: 'blob' | 'tree'; object: string; size: number | null; path: string }[] = [];
  for (const rec of tokens(z)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, object, size] = rec.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' && type !== 'tree') continue;
    out.push({ type, object, size: size === '-' || size === undefined ? null : Number(size), path: rec.slice(tab + 1) });
  }
  return out;
}

/** One folder's entries from parseLsTree: folders first, then by name. */
export function treeEntries(z: string): TreeEntry[] {
  return parseLsTree(z)
    .map((e): TreeEntry => {
      const name = e.path.slice(e.path.lastIndexOf('/') + 1);
      return e.type === 'tree' ? { name, path: e.path, type: 'dir', size: null } : { name, path: e.path, type: 'file', size: e.size };
    })
    .sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
