#!/usr/bin/env node
// Record real `claude` and `gh` output as test fixtures, so the parsers and the fakes can be checked against them
// (daemon/test/contracts.test.ts). Workers can't reach Anthropic or GitHub, so a person runs this, in a session.
//
// Usage: node daemon/scripts/record-fixtures.mjs [--repo owner/name] [--check]
//   --repo   the GitHub repo whose PRs are read (default: this checkout's origin)
//   --check  only say whether the fixtures were recorded with the installed claude and gh
//
// Writes daemon/test/fixtures/claude/*.jsonl, daemon/test/fixtures/gh/*.json|txt and daemon/test/fixtures/versions.json.
// The claude runs use haiku in a scratch repo and cost a few cents. Paths under $HOME, session ids, uuids and emails
// are scrubbed.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { repo: { type: 'string' }, check: { type: 'boolean', default: false } } });
const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'daemon/test/fixtures');
const VERSIONS = join(OUT, 'versions.json');

const version = (cmd) => execFileSync(cmd, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
const installed = { claude: version('claude'), gh: version('gh') };

if (opts.check) {
  if (!existsSync(VERSIONS)) {
    console.log('no fixtures recorded yet: run node daemon/scripts/record-fixtures.mjs');
    process.exit(1);
  }
  const recorded = JSON.parse(readFileSync(VERSIONS, 'utf8'));
  let stale = false;
  for (const tool of ['claude', 'gh']) {
    const same = recorded[tool] === installed[tool];
    stale ||= !same;
    console.log(`${tool}: recorded with ${recorded[tool]}${same ? ', as installed' : `; installed is ${installed[tool]}: re-record`}`);
  }
  console.log(`recorded ${recorded.recorded_at}`);
  process.exit(stale ? 1 : 0);
}

const HOME = homedir();
/** Scrub what identifies this machine or session from recorded text. */
function scrub(text, extra = []) {
  let out = text;
  for (const [from, to] of extra) out = out.split(from).join(to);
  return out
    .split(HOME)
    .join('/HOME')
    .replace(/\/private\/var\/folders\/[^"\s]+/g, '/TMP')
    .replace(/\/var\/folders\/[^"\s]+/g, '/TMP')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '00000000-0000-0000-0000-000000000000')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'person@example.com');
}

function write(path, text) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  console.log(`wrote ${path.slice(ROOT.length + 1)} (${text.split('\n').filter(Boolean).length} lines)`);
}

// ── claude ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-fixtures-'));
const git = (...args) => execFileSync('git', args, { cwd: scratch, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
writeFileSync(join(scratch, 'README.md'), '# Fixture repo\n\nHello from the fixture repo.\n');
git('add', '.');
git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'init');

const SCHEMA = {
  type: 'object',
  properties: { word: { type: 'string' }, lines: { type: 'integer' } },
  required: ['word', 'lines'],
};
const base = ['--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--permission-mode', 'dontAsk', '--strict-mcp-config'];
const RUNS = [
  {
    name: 'done-with-tool',
    what: 'a short run that reads a file and finishes',
    args: ['-p', 'Read README.md and reply with its second line, nothing else.', ...base, '--max-turns', '5', '--allowedTools', 'Read'],
  },
  {
    name: 'max-turns',
    what: 'a run cut off by --max-turns 1 (error_max_turns)',
    args: [
      '-p',
      'Read README.md, then read it again, then reply with its line count.',
      ...base,
      '--max-turns',
      '1',
      '--allowedTools',
      'Read',
    ],
  },
  {
    name: 'denied-tool',
    // Claude Code lets read-only commands such as `ls` through even in dontAsk mode, so this one writes a file.
    what: 'a run whose Bash call is refused by the tool rules',
    args: ['-p', 'Use Bash to run `touch out.txt`, then reply done.', ...base, '--max-turns', '4', '--allowedTools', 'Read'],
  },
  {
    name: 'structured-output',
    what: "a --json-schema run like the planner's",
    args: [
      '-p',
      'Read README.md. Answer with its first word after the heading and its line count.',
      ...base,
      '--max-turns',
      '5',
      '--allowedTools',
      'Read',
      '--json-schema',
      JSON.stringify(SCHEMA),
    ],
  },
];

const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
for (const run of RUNS) {
  const r = spawnSync('claude', run.args, { cwd: scratch, encoding: 'utf8', env, timeout: 180_000 });
  if (!r.stdout.trim()) {
    console.error(`claude ${run.name} printed nothing (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
    process.exit(1);
  }
  write(join(OUT, 'claude', `${run.name}.jsonl`), scrub(r.stdout, [[scratch, '/WORKTREE']]));
}
rmSync(scratch, { recursive: true, force: true });

// ── gh ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ghJson = (args) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const repo = opts.repo ?? JSON.parse(ghJson(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
const FIELDS = 'state,headRefOid,isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup';
const WITH_FILES = `${FIELDS},files,labels`;

const prs = JSON.parse(ghJson(['pr', 'list', '-R', repo, '--state', 'all', '-L', '200', '--json', 'number,state,changedFiles']));
const pick = (label, find) => {
  const pr = prs.find(find);
  if (!pr) console.log(`no ${label} PR in ${repo}: skipped`);
  return pr;
};
const GH_CASES = [
  { name: 'pr-view-merged', pr: pick('merged', (p) => p.state === 'MERGED' && p.changedFiles < 50), fields: WITH_FILES },
  { name: 'pr-view-open', pr: pick('open', (p) => p.state === 'OPEN'), fields: WITH_FILES },
  { name: 'pr-view-open-no-files', pr: pick('open', (p) => p.state === 'OPEN'), fields: FIELDS },
  { name: 'pr-view-over-100-files', pr: pick('over 100 files', (p) => p.changedFiles > 100), fields: WITH_FILES },
  { name: 'pr-view-closed', pr: pick('closed', (p) => p.state === 'CLOSED'), fields: FIELDS },
];
for (const c of GH_CASES) {
  if (!c.pr) continue;
  const out = ghJson(['pr', 'view', String(c.pr.number), '-R', repo, '--json', c.fields]);
  write(join(OUT, 'gh', `${c.name}.json`), scrub(JSON.stringify(JSON.parse(out), null, 1)));
}

const failed = JSON.parse(ghJson(['run', 'list', '-R', repo, '--status', 'failure', '-L', '1', '--json', 'databaseId']))[0];
if (failed) {
  const r = spawnSync('gh', ['run', 'view', String(failed.databaseId), '-R', repo, '--log-failed'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = r.stdout.split('\n');
  write(join(OUT, 'gh', 'run-log-failed.txt'), scrub(lines.slice(-300).join('\n')));
} else console.log(`no failed run in ${repo}: run-log-failed skipped`);

write(VERSIONS, JSON.stringify({ ...installed, recorded_at: new Date().toISOString().slice(0, 10), repo }, null, 1));
