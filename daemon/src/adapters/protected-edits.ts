// Protected edits in a task's worktree (domain/run/protected-edits.ts): what a worker wrote to the edits folder, copied
// to its place, committed on the task's branch, and the folder cleared.
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { EDITS_FOLDER, EDIT_LIMIT, protectedEditTarget, protectedEditsMessage } from '../domain/run/protected-edits.ts';
import { commitFiles } from './git.ts';

export interface AppliedEdits {
  /** The files written and committed, from the repo root. */
  applied: string[];
  /** The edits left out, by their path in the edits folder, and why. Nothing is written for them. */
  refused: { path: string; reason: string }[];
}

/**
 * Copy every file in the worktree's edits folder to the protected file it replaces (`protectedEditTarget`), commit the
 * ones that changed in one commit, and remove the folder, whatever happened. Only regular files are read (a symlink is
 * refused, so nothing outside the worktree is copied in), and a target whose folder resolves outside the worktree or
 * that is not a regular file is refused, so nothing is written outside it either.
 */
export async function applyProtectedEdits(worktree: string): Promise<AppliedEdits> {
  const folder = join(worktree, EDITS_FOLDER);
  const out: AppliedEdits = { applied: [], refused: [] };
  try {
    const files = await listFiles(folder, '', out.refused);
    if (!files.length) return out;
    const root = await realpath(worktree);
    for (const rel of files) {
      const refuse = (reason: string) => out.refused.push({ path: rel, reason });
      const target = protectedEditTarget(rel);
      if ('refused' in target) {
        refuse(target.refused);
        continue;
      }
      const src = join(folder, rel);
      if ((await lstat(src)).size > EDIT_LIMIT) {
        refuse(`bigger than ${EDIT_LIMIT} bytes`);
        continue;
      }
      const dest = join(worktree, target.target);
      const problem = await unsafeTarget(root, dest);
      if (problem) {
        refuse(problem);
        continue;
      }
      try {
        const text = await readFile(src);
        const old = await readFile(dest).catch(() => null);
        if (old?.equals(text)) continue;
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, text);
        out.applied.push(target.target);
      } catch (err) {
        refuse((err as Error).message);
      }
    }
    if (out.applied.length) await commitFiles(worktree, out.applied, protectedEditsMessage(out.applied));
    return out;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The regular files under `dir`, as paths relative to the edits folder; anything else is refused. */
async function listFiles(dir: string, prefix: string, refused: AppliedEdits['refused']): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await listFiles(join(dir, e.name), rel, refused)));
    else if (e.isFile()) files.push(rel);
    else refused.push({ path: rel, reason: 'not a regular file' });
  }
  return files.sort();
}

/** Why writing `dest` could reach outside the worktree at `root` (a real path), or null when it can't. */
async function unsafeTarget(root: string, dest: string): Promise<string | null> {
  const info = await lstat(dest).catch(() => null);
  if (info && !info.isFile()) return 'the target is not a regular file';
  // The nearest folder that exists must resolve inside the worktree; the ones under it are made fresh.
  let dir = dirname(dest);
  for (;;) {
    const real = await realpath(dir).catch(() => null);
    if (real !== null) {
      const rel = relative(root, real);
      return rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? 'the target folder resolves outside the worktree' : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return 'the target folder does not exist';
    dir = parent;
  }
}
