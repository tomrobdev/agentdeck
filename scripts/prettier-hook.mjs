// Claude Code PostToolUse hook (.claude/settings.json): format the file an Edit or Write just changed with the repo's
// Prettier, so sessions and workers write formatted code as they go. Quiet, and never fails the edit.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const file = input?.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const prettier = join(root, 'node_modules', '.bin', 'prettier');
  const rel = typeof file === 'string' ? relative(root, file) : '';
  // Only files inside this checkout; prettier skips what .prettierignore names and what it can't parse.
  if (rel && !rel.startsWith('..') && !isAbsolute(rel) && existsSync(file) && existsSync(prettier))
    execFileSync(prettier, ['--write', '--ignore-unknown', '--log-level', 'silent', file], { cwd: root, stdio: 'ignore', timeout: 15_000 });
} catch {
  // A file prettier can't parse yet stays as written; `pnpm format:check` still catches it.
}
