// GLOSSARY.md's `_Avoid_:` words appear nowhere in code, logs or UI (daemon/src and app/src), except on lines the allow list names.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { avoidedLines, parseGlossary, readGlossary } from '#scripts/lib/vocabulary.ts';

const ROOT = join(import.meta.dirname, '../../..');

const PLAIN = 'plain English: a thing contains, keeps or presses something';
const JOB = "GitHub's word: a job in a workflow run";
const OTHER_JOB = 'plain English: a unit of async work, or a duty';
type Allowed = { file: string; line: RegExp; why: string };

const ALLOWED: Allowed[] = [
  { file: 'domain/operations/notification.ts', line: /governor hold|'hold'/, why: 'the `hold` notification kind' },
  { file: 'api/contract/operations.ts', line: /rate limit or a hold ends/, why: "the governor's hold" },
  { file: 'domain/operations/headline.ts', line: /'hold'|a hold ends/, why: "the governor's hold, as a headline state" },
  { file: 'app/src/lib/operations/daemon-wording.ts', line: /case 'hold':/, why: "the governor's hold, as a headline state" },
  { file: 'adapters/macos/notify.ts', line: /^\s*hold:/, why: 'the `hold` notification kind' },
  { file: 'db/schema.ts', line: /`hold`|,hold,/, why: 'migration 16 is about the `hold` notification kind' },
  { file: 'app/src/components/operations/settings/RecentAlerts.vue', line: /kind === 'hold'/, why: 'the `hold` notification kind' },
  { file: 'app/src/lib/operations/daemon-wording.ts', line: /^\s*hold: /, why: 'the `hold` notification kind' },
  { file: 'app/src/components/operations/settings/BudgetSettings.vue', line: /Hold new tasks above/, why: 'the governor budget setting' },
  { file: 'domain/operations/digest.ts', line: /governor on hold/, why: 'the governor' },
  { file: 'domain/work/task/start.ts', line: /governor holds/, why: 'the governor' },
  {
    file: 'application/scheduler/scheduler.ts',
    line: /a hold once|const hold = |\bhold( &&|\.\w)|governor hold|kind: 'hold'|hold lifted/,
    why: "the scheduler's hold announcement",
  },
  { file: 'cli/operations/daemon.ts', line: /on hold|HOLD:/, why: "the governor's state, shown" },
  { file: 'app/src/lib/operations/daemon-wording.ts', line: /On hold/, why: "the governor's state, shown" },
  { file: 'app/src/lib/work/work-wording.ts', line: /On hold/, why: "the governor's wait, shown" },
  { file: 'app/src/components/layout/StatusBar.vue', line: /On hold/, why: "the governor's state, shown" },
  { file: 'domain/runs/prompt.ts', line: /holds the same comments|already holds the task|files hold conflict markers/, why: PLAIN },
  { file: 'domain/operations/health.ts', line: /another daemon holds port/, why: PLAIN },
  { file: 'domain/landing/pull-request/checks.ts', line: /\bjobs?\b/i, why: JOB },
  { file: 'domain/landing/pull-request/check-failures.ts', line: /\bjobs?\b/i, why: JOB },
  { file: 'domain/landing/pull-request/ci-not-run.ts', line: /\bjobs?\b/i, why: JOB },
  { file: 'adapters/github/github.ts', line: /\bjobs?\b/i, why: JOB },
  { file: 'application/landing/pull-request/check-failures.ts', line: /\bjobs?\b/i, why: JOB },
  { file: 'application/ports/code-host.ts', line: /\bjobs?\b/i, why: JOB },
  { file: 'compose.ts', line: /\bjob\b/, why: JOB },
  { file: 'app/src/components/landing/PullRequestCard.vue', line: /\bjob\b/i, why: JOB },
  { file: 'application/operations/notifications.ts', line: /\bjobs\b/, why: OTHER_JOB },
];

function scan(files: Map<string, string>, words: string[], allowed: Allowed[]) {
  const found: string[] = [];
  const used = new Set<Allowed>();
  for (const [path, text] of files) {
    if (path.startsWith('domain/capacity/')) continue;
    for (const l of avoidedLines(text, words)) {
      const ok = allowed.find((a) => a.file === path && a.line.test(l.text));
      if (ok) used.add(ok);
      else found.push(`${path}:${l.line} says an avoid-word from GLOSSARY.md: use the glossary's word (or add the sense to ALLOWED)`);
    }
  }
  return { found, used };
}

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const { dir, prefix } of [
    { dir: join(ROOT, 'daemon/src'), prefix: '' },
    { dir: join(ROOT, 'app/src'), prefix: 'app/src/' },
  ]) {
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (/\.(ts|vue|css)$/.test(f)) files.set(prefix + f, readFileSync(join(dir, f), 'utf8'));
    }
  }
  return files;
}

const avoidWords = () => readGlossary().flatMap((t) => t.avoid);

test('[vocabulary] avoid-words from GLOSSARY.md appear only on allowed lines', () => {
  const { found, used } = scan(sourceFiles(), avoidWords(), ALLOWED);
  for (const a of ALLOWED) if (!used.has(a)) found.push(`${a.file} ${a.line} is on the allow list but matches no line`);
  assert.deepEqual(found, []);
});

test('[vocabulary] "hold" is still an avoid-word', () => {
  assert.ok(avoidWords().includes('hold'));
});

test('[vocabulary] a sample file with an avoid-word fails, and an allowed line does not', () => {
  const glossary = parseGlossary('**Task**: a unit of work.\n_Avoid_: ticket, job\n\n**Sync**: x.\n_Avoid_: bring in\n');
  const words = glossary.flatMap((t) => t.avoid);
  assert.deepEqual(words, ['ticket', 'job', 'bring in']);
  const files = new Map([['domain/sample.ts', 'const a = 1;\n// Open a ticket for it\n// bring  in the base branch\n']]);
  assert.equal(scan(files, words, []).found.length, 2);
  const allowed = [{ file: 'domain/sample.ts', line: /ticket/, why: 'sample' }];
  assert.equal(scan(files, words, allowed).found.length, 1);
  assert.equal(scan(new Map([['domain/sample.ts', 'tickets']]), words, []).found.length, 0, 'whole words only');
});

test('[vocabulary] CLAUDE.md imports GLOSSARY.md and no longer has its own Domain language', () => {
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^@GLOSSARY\.md$/m);
  assert.doesNotMatch(claude, /^## Domain language/m);
});
