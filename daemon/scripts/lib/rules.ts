// The rules in CLAUDE.md's Boundaries and Rules, and the tests that enforce them. A rule's id is a `<!-- rule:ID -->` comment at the
// end of its line; a test names the rules it enforces at the start of its name: test('[sql-in-db] SQL runs only in db/', …).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');
const TESTS = join(ROOT, 'daemon/test');

/** Rules no test enforces, each with why. A new rule gets a check, or goes here with its reason. */
export const UNCHECKED: Record<string, string> = {
  'cli-in-process': 'no test yet: whether a use case runs in the CLI process or goes to the daemon is not visible in imports',
  'composition-root': 'no test yet: "logs through a callback and throws" is not checked',
  'erasable-ts': 'enforced by `erasableSyntaxOnly` in tsconfig, so by `pnpm typecheck`, not by a test',
  'main-checkout': 'a working-copy state a test cannot see; the reload guard only stops the daemon reloading onto another branch',
  'delegate-skill': 'a pointer to a skill, not a behaviour; doc-paths.test.ts only checks that the path exists',
};

/** Rules a script enforces rather than a test, each with the script and what makes it fail. The rule's test checks its inputs. */
export const SCRIPT_CHECKS: Record<string, string> = {
  'coverage-floors':
    'pnpm coverage (daemon/scripts/coverage.ts; CI runs it): fails when a group of daemon/src drops below its floor in COVERAGE_FLOORS',
};

export type Rule = { id: string; text: string; tests: string[]; script: string | null; unchecked: string | null };

/** The ids on each rule line of CLAUDE.md's Boundaries and Rules, with the line's text. */
export function readRuleLines(): { ids: string[]; text: string; line: number; isBullet: boolean }[] {
  const lines = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split('\n');
  const found: ReturnType<typeof readRuleLines> = [];
  let inRules = false;
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('## ')) inRules = line === '## Boundaries' || line === '## Rules';
    if (!inRules) continue;
    const ids = [...line.matchAll(/<!--\s*rule:([a-z0-9-]+)\s*-->/g)].map((m) => m[1]);
    const isBullet = line.startsWith('- ');
    if (ids.length || isBullet) found.push({ ids, text: line.replace(/<!--.*?-->/g, '').trim(), line: i + 1, isBullet });
  }
  return found;
}

/** Every `test('[id, id] name'` in daemon/test, as the test's name and the ids it names. */
export function readTestTags(): { file: string; name: string; ids: string[] }[] {
  const found: ReturnType<typeof readTestTags> = [];
  for (const file of readdirSync(TESTS, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.test.ts'))
    .sort()) {
    const source = readFileSync(join(TESTS, file), 'utf8');
    for (const m of source.matchAll(/\btest\(\s*(['"`])\[([^\]]*)\]\s*([^\n]*?)\1/g)) {
      found.push({ file, name: m[3], ids: m[2].split(',').map((s) => s.trim()) });
    }
  }
  return found;
}

export function readRules(): Rule[] {
  const tags = readTestTags();
  return readRuleLines()
    .flatMap((l) => l.ids.map((id) => ({ id, text: l.text })))
    .map(({ id, text }) => ({
      id,
      text,
      tests: tags.filter((t) => t.ids.includes(id)).map((t) => `${t.file}: ${t.name}`),
      script: SCRIPT_CHECKS[id] ?? null,
      unchecked: UNCHECKED[id] ?? null,
    }));
}
