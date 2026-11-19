#!/usr/bin/env node
// Fake `gh` for the crash test. Every call is appended to $FAKE_GH_DIR/gh-calls.jsonl, and the PRs it opens live there too:
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = process.env.FAKE_GH_DIR;
const FIXTURES = resolve(import.meta.dirname, '../test/fixtures/gh');
const CALLS = join(dir, 'gh-calls.jsonl');
const HANG = join(dir, 'hang-pr');
const LAND_HANG = join(dir, 'hang-land');
const args = process.argv.slice(2);
const [cmd, sub] = args;
const rec = (kind, more = {}) => appendFileSync(CALLS, JSON.stringify({ kind, pid: process.pid, t: Date.now(), ...more }) + '\n');
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const fail = (msg) => {
  process.stderr.write(msg + '\n');
  process.exit(1);
};
const urlOf = (number) => `https://github.com/demo/demo/pull/${number}`;

function prs() {
  const lines = existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const list = [];
  for (const c of lines) {
    if (c.kind === 'created') list.push({ number: list.length + 1, head: c.head, base: c.base, draft: c.draft, state: 'OPEN' });
    else if (c.kind === 'merged' || c.kind === 'closed') {
      const pr = list.find((p) => urlOf(p.number) === c.url);
      if (pr) pr.state = c.kind.toUpperCase();
    }
  }
  return list.map((p) => ({ ...p, url: urlOf(p.number) }));
}

function fromGit(pr) {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('fetch', '-q', 'origin');
  const head = git('rev-parse', `origin/${pr.head}`);
  const files = git('diff', '--numstat', '--no-renames', `origin/${pr.base}...${head}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, path] = line.split('\t');
      return { path, additions: Number(additions), deletions: Number(deletions), changeType: 'MODIFIED' };
    });
  const sum = (key) => files.reduce((n, f) => n + f[key], 0);
  return { headRefOid: head, files, changedFiles: files.length, additions: sum('additions'), deletions: sum('deletions') };
}

async function hang(when, phase = 'pr') {
  const file = phase === 'pr' ? HANG : LAND_HANG;
  appendFileSync(join(dir, 'hangs.jsonl'), JSON.stringify({ phase, when, pid: process.pid, t: Date.now() }) + '\n');
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(file)) process.exit(1);
  }
}

const landHang = () => (existsSync(LAND_HANG) ? readFileSync(LAND_HANG, 'utf8').trim() : null);

async function create() {
  const head = flag('--head');
  const base = flag('--base');
  rec('create_start', { head });
  const when = existsSync(HANG) ? readFileSync(HANG, 'utf8').trim() || 'before' : null;
  if (when === 'before') await hang(when);
  const open = prs().find((p) => p.head === head && p.base === base && p.state === 'OPEN');
  if (open) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${open.url}`);
  rec('created', { head, base, draft: args.includes('--draft') });
  const mine = prs()
    .filter((p) => p.head === head)
    .at(-1);
  if (when === 'after') await hang(when);
  process.stdout.write(`${mine.url}\n`);
}

function named() {
  const url = args[2];
  const pr = prs().find((p) => p.url === url);
  if (!pr) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${url?.split('/').at(-1)}. (repository.pullRequest)`);
  return pr;
}

rec('call', { args: args.slice(0, 3) });
if (cmd === 'auth' && sub === 'status') {
  process.stderr.write('github.com\n  ✓ Logged in to github.com account demo (keyring)\n');
} else if (cmd === 'label' && sub === 'create') {
} else if (cmd === 'pr' && sub === 'create') {
  await create();
} else if (cmd === 'pr' && sub === 'list') {
  const head = flag('--head');
  const list = prs()
    .filter((p) => p.head === head)
    .reverse()
    .map((p) => ({ url: p.url, state: p.state }));
  process.stdout.write(JSON.stringify(list) + '\n');
} else if (cmd === 'pr' && sub === 'view') {
  const pr = named();
  if (pr.state === 'MERGED' && landHang() === 'merged') await hang('merged', 'land');
  const recorded = JSON.parse(fixture(pr.state === 'MERGED' ? 'pr-view-merged.json' : 'pr-view-open.json'));
  const own = join(dir, `pr-view-${pr.number}.json`);
  const answer = {
    ...recorded,
    ...(process.env.FAKE_GH_FROM_GIT === '1' ? fromGit(pr) : {}),
    state: pr.state,
    isDraft: pr.state === 'OPEN' && pr.draft,
    ...(existsSync(own) ? JSON.parse(readFileSync(own, 'utf8')) : {}),
  };
  process.stdout.write(JSON.stringify(answer) + '\n');
} else if (cmd === 'pr' && sub === 'merge') {
  const pr = named();
  if (pr.state !== 'OPEN') fail(`Pull request #${pr.number} is not mergeable: the pull request is ${pr.state.toLowerCase()}`);
  if (landHang() === 'between' && prs().some((p) => p.state === 'MERGED')) await hang('between', 'land');
  rec('merged', { url: pr.url });
} else if (cmd === 'pr' && sub === 'close') {
  rec('closed', { url: named().url });
} else if (cmd === 'pr' && (sub === 'ready' || sub === 'edit')) {
  named();
} else if (cmd === 'api' && /\/actions\/jobs\/\d+$/.test(sub ?? '')) {
  process.stdout.write(fixture('job-steps-coverage-failed.json'));
} else if (cmd === 'run' && sub === 'view' && args.includes('--log-failed')) {
  process.stdout.write(fixture('run-log-failed.txt'));
} else {
  fail(`fake gh: no answer for: gh ${args.slice(0, 3).join(' ')}`);
}
