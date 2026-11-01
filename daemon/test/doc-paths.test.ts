// Docs name files; this fails when one of those files has moved or been renamed, so docs stop pointing at nothing.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '../..');

/** Exceptions: `doc: path` mapped to why that path is allowed to be missing. Prefer fixing the doc. */
const EXCEPTIONS: Record<string, string> = {
  'docs/plan-format.md: 112-plans-in-agentdeck.html': 'an example of how a plan is named, not a real file',
  'docs/plan-format.md: .agentdeck/plan.html': "the plan file, in a task's worktree while it runs",
};

/** What counts as a file name: dotted identifiers such as `repos.network` and CSS classes such as `.pill` do not. */
const FILE_EXTENSIONS = /\.(ts|mts|mjs|js|vue|md|html|css|json|toml|rs|sh|sql|plist|ya?ml|lock|txt|svg|png)$/;

function markdownIn(dir: string): string[] {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f));
}

function docFiles(): string[] {
  const skills = readdirSync(join(ROOT, '.claude/skills'))
    .map((s) => join('.claude/skills', s, 'SKILL.md'))
    .filter((f) => existsSync(join(ROOT, f)));
  // Plans in docs/plans/ are left out: they describe files that don't exist yet.
  return ['CLAUDE.md', 'README.md', ...skills, ...markdownIn('docs'), ...markdownIn('docs/adr')].filter((f) => existsSync(join(ROOT, f)));
}

/** `dir` itself and every folder under it. */
function layerFolders(dir: string): string[] {
  return [
    dir,
    ...readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => statSync(join(ROOT, dir, f)).isDirectory())
      .map((f) => join(dir, f)),
  ];
}

const BASES = ['', 'daemon', 'app', 'docs', ...layerFolders('daemon/src'), ...layerFolders('app/src'), 'app/src-tauri'];

/** Every folder in the tree (ignoring dependencies and build output), by name. */
function foldersByName(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', 'target', 'dist', '.git'].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      out.set(entry.name, [...(out.get(entry.name) ?? []), path]);
      walk(path);
    }
  };
  walk('');
  return out;
}

const FOLDERS = foldersByName();

function exists(path: string): boolean {
  return existsSync(join(ROOT, path));
}

/** Is `path` (as written, on a line where `before` precedes it) a file that exists? */
function resolves(path: string, before: string): boolean {
  if (BASES.some((base) => exists(join(base, path)))) return true;
  // `planner/` (`proposals.ts`): relative to the folder named just before it.
  const folder = /`([\w.-]+)\/`[^`]*$/.exec(before)?.[1] ?? /\b([\w.-]+)\/\s*\([^`]*$/.exec(before)?.[1];
  return !!folder && (FOLDERS.get(folder) ?? []).some((dir) => exists(join(dir, path)));
}

function missingPaths(doc: string): { line: number; path: string }[] {
  const out: { line: number; path: string }[] = [];
  readFileSync(join(ROOT, doc), 'utf8')
    .split('\n')
    .forEach((text, i) => {
      for (const m of text.matchAll(/`([^`]+)`/g)) {
        const path = m[1]!;
        if (/[\s*<~$:]/.test(path) || !FILE_EXTENSIONS.test(path)) continue;
        // `.ts`, `.pill`: an extension or a CSS class, not a file.
        if (path.startsWith('.') && !path.includes('/')) continue;
        const before = text.slice(0, m.index);
        if (!resolves(path.replace(/^\.\//, ''), before) && !(`${doc}: ${path}` in EXCEPTIONS)) out.push({ line: i + 1, path });
      }
    });
  return out;
}

test('every file path named in the docs exists', () => {
  const failures = docFiles().flatMap((doc) =>
    missingPaths(doc).map(({ line, path }) => `${relative('.', join(ROOT, doc))}:${line}: \`${path}\` does not exist`),
  );
  assert.deepEqual(failures, [], `Docs name files that don't exist. Fix the path in the doc:\n${failures.join('\n')}`);
});
