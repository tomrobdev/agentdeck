// Claude Code PostToolUse hook (.claude/settings.json), after each Edit or Write:
// 1. format the changed file with the repo's Prettier, so sessions and workers write formatted code as they go;
// 2. when it is under daemon/src (or is the docs generator), regenerate docs/architecture.md's generated blocks
//    (`pnpm docs:gen`, about 0.25s), so the architecture test never finds them stale.
// Quiet, and never fails the edit: a file mid-edit that doesn't parse yet is left for `pnpm check` to catch.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const run = (cmd, args, cwd) => {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'ignore', timeout: 15_000 });
  } catch {
    // see above
  }
};

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const file = input?.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const rel = typeof file === 'string' ? relative(root, file).split(sep).join('/') : '';
  // Only files inside this checkout.
  if (rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(file)) {
    const prettier = join(root, 'node_modules', '.bin', 'prettier');
    // Prettier skips what .prettierignore names and what it can't parse.
    if (existsSync(prettier)) run(prettier, ['--write', '--ignore-unknown', '--log-level', 'silent', file], root);
    const docs = join(root, 'daemon', 'scripts', 'docs.ts');
    if ((rel.startsWith('daemon/src/') || rel === 'daemon/scripts/lib/architecture-docs.ts') && existsSync(docs))
      run(process.execPath, [docs], join(root, 'daemon'));
  }
} catch {
  // bad input: nothing to do
}
