// Claude Code PostToolUse hook (.claude/settings.json), after each Edit or Write:
// 1. format the changed file with the repo's Prettier, so sessions and workers write formatted code as they go;
// 2. when it is under daemon/src (or is the docs generator), regenerate docs/architecture.md's generated blocks
//    (`pnpm docs:gen`, about 0.25s), so the architecture test never finds them stale.
// 3. under daemon/src, run daemon/test/architecture.test.ts (about 1.5s) and show its failures to the session
//    (stderr, exit 2: the edit itself has already happened and stays), so a broken layer rule is seen at once.
// Quiet when all is well, and never fails the edit: a file mid-edit that doesn't parse yet is left for `pnpm check` to catch.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Failures to show the session; set by the architecture test below. */
let failures = '';

const run = (cmd, args, cwd) => {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'ignore', timeout: 15_000 });
  } catch {
    // see above
  }
};

/** The architecture test's output when it fails, else ''. A test that can't run at all is left for `pnpm check`. */
function architectureFailures(test, cwd) {
  try {
    execFileSync(process.execPath, ['--test', test], {
      cwd,
      stdio: 'pipe',
      timeout: 15_000,
      env: { ...process.env, AGENTDECK_NO_NOTIFY: '1' },
    });
    return '';
  } catch (e) {
    if (e?.killed || typeof e?.status !== 'number') return '';
    return String(e.stdout ?? '')
      .split('\n')
      .filter((l) => /not ok|rule|Error|\.ts:\d+/.test(l))
      .join('\n')
      .slice(0, 3000);
  }
}

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
    const test = join(root, 'daemon', 'test', 'architecture.test.ts');
    if (rel.startsWith('daemon/src/') && existsSync(test)) failures = architectureFailures(test, join(root, 'daemon'));
  }
} catch {
  // bad input: nothing to do
}

if (failures) {
  process.stderr.write(`Architecture test failed after this edit (the edit stays; fix it before finishing):\n${failures}\n`);
  process.exit(2);
}
