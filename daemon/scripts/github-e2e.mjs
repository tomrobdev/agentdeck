#!/usr/bin/env node
// End to end against a real GitHub repo: the daemon, with the fake claude, takes tasks from done to merged on GitHub.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, record: { type: 'boolean', default: false } } });
const ROOT = resolve(import.meta.dirname, '../..');
const DAEMON = join(ROOT, 'daemon');
const CLI = join(DAEMON, 'src/cli.ts');
const FAKE_CLAUDE = join(DAEMON, 'test/fixtures/fake-claude.mjs');
const REPO_NAME = 'e2e';
const BRANCH_PREFIX = 'agentdeck/';
const BRANCH_PREFIXES = [BRANCH_PREFIX, 'plan/'];
const isOurs = (branch) => BRANCH_PREFIXES.some((p) => branch.startsWith(p));
const FIXTURES = join(ROOT, 'daemon/test/fixtures/gh');
const PLAN_HTML = `<!doctype html>
<html lang="en" data-agentdeck-plan="1">
  <head><meta charset="utf-8" /><title>E2E plan branch</title></head>
  <body>
    <p data-plan-summary>Three small steps that land on a plan branch.</p>
    <section data-plan-step id="one" data-status="todo"><h2>One</h2></section>
    <section data-plan-step id="two" data-status="todo"><h2>Two</h2></section>
    <section data-plan-step id="three" data-status="todo"><h2>Three</h2></section>
  </body>
</html>
`;
const RESET_SUBJECT = 'agentdeck github-e2e: reset';
const CHECK_NAME = 'check';
const WORKFLOW = `# Written by AgentDeck's github-e2e reset (daemon/scripts/github-e2e.mjs): one quick check on every PR.
name: agentdeck-e2e
on:
  pull_request:
jobs:
  ${CHECK_NAME}:
    runs-on: ubuntu-latest
    steps:
      - run: echo "checked \${{ github.event.pull_request.head.sha }}"
`;
const README = `# AgentDeck end-to-end repo

A throwaway repo for AgentDeck's \`pnpm test:github\`. Every run force-pushes main and deletes its branches: keep nothing here.
`;
const STEP_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 3_000;
const POKE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const secs = (since) => `${Math.round((Date.now() - since) / 1000)}s`;

function refuse(why) {
  console.error(`test:github refused to run: ${why}`);
  console.error('see docs/github-e2e.md');
  process.exit(2);
}

function run(cmd, args, { cwd = ROOT, env = process.env, input } = {}) {
  try {
    return execFileSync(cmd, args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const stderr = String(err.stderr ?? '').trim();
    const stdout = String(err.stdout ?? '').trim();
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${(stderr || stdout || err.message).split('\n').slice(0, 4).join(' ')}`);
  }
}
const gh = (...args) => run('gh', args);
const ghJson = (...args) => JSON.parse(gh(...args));

const REPO = process.env.AGENTDECK_GITHUB_E2E_REPO?.trim();
if (!REPO) refuse('AGENTDECK_GITHUB_E2E_REPO is not set; set it to a throwaway repo, owner/name');
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) refuse(`AGENTDECK_GITHUB_E2E_REPO must be owner/name, got "${REPO}"`);
const REPO2 = process.env.AGENTDECK_GITHUB_E2E_REPO_2?.trim();
if (!REPO2) refuse('AGENTDECK_GITHUB_E2E_REPO_2 is not set; set it to a second throwaway repo, owner/name, for the plan across repos');
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO2)) refuse(`AGENTDECK_GITHUB_E2E_REPO_2 must be owner/name, got "${REPO2}"`);
if (REPO2.toLowerCase() === REPO.toLowerCase()) refuse('AGENTDECK_GITHUB_E2E_REPO_2 must be another repo than AGENTDECK_GITHUB_E2E_REPO');
const REPO2_NAME = 'e2e2';
const REPO2_BASE = 'develop';
const origin = (() => {
  try {
    return run('git', ['remote', 'get-url', 'origin']);
  } catch {
    return '';
  }
})();
const originRepo = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(origin)?.[1]?.toLowerCase();
const isOrigin = (name) => !!originRepo && originRepo === name.toLowerCase();
for (const r of [REPO, REPO2]) if (isOrigin(r)) refuse(`${r} is this checkout's origin; the reset would force-push it`);
try {
  execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
  refuse('gh is not logged in (or not installed): run gh auth login');
}
function repoInfo(repo) {
  let found;
  try {
    found = ghJson('repo', 'view', repo, '--json', 'nameWithOwner,isArchived,viewerPermission,url');
  } catch (err) {
    refuse(`gh cannot read ${repo}: ${err.message}`);
  }
  if (isOrigin(found.nameWithOwner)) refuse(`${found.nameWithOwner} is this checkout's origin; the reset would force-push it`);
  if (found.isArchived) refuse(`${repo} is archived`);
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(found.viewerPermission))
    refuse(`gh's account can't push to ${repo} (permission ${found.viewerPermission})`);
  return found;
}
const info = repoInfo(REPO);
repoInfo(REPO2);

const HOME = mkdtempSync(join(tmpdir(), 'agentdeck-github-e2e-'));
const DB_PATH = join(HOME, 'agentdeck.db');
const DAEMON_LOG = join(HOME, 'daemon.log');
const port = await new Promise((r) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => r(free));
  });
});
const { AGENTDECK_TASK_ID: _task, AGENTDECK_PLANNER: _planner, ...inherited } = process.env;
const ENV = {
  ...inherited,
  AGENTDECK_HOME: HOME,
  AGENTDECK_CLAUDE_BIN: FAKE_CLAUDE,
  AGENTDECK_NO_NOTIFY: '1',
  AGENTDECK_PORT: String(port),
};
const cli = (...args) => run(process.execPath, [CLI, ...args], { env: ENV });
let daemon = null;
let db = null;
const clonePath = join(HOME, REPO_NAME);

function database() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return db;
}
const taskRow = (id) => database().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const runsOf = (id, kind) => database().prepare('SELECT * FROM runs WHERE task_id = ? AND kind = ? ORDER BY id').all(id, kind);
const reviewsOf = (id) => database().prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY id').all(id);

let lastPoke = 0;
function pokeRefresh() {
  if (Date.now() - lastPoke < POKE_MS) return;
  lastPoke = Date.now();
  database()
    .prepare("INSERT INTO settings (key, value) VALUES ('pr_check_requested', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(Date.now()));
}

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

async function waitFor(what, check, timeoutMs = STEP_TIMEOUT_MS) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    if (daemon?.exitCode !== null && daemon?.exitCode !== undefined)
      throw new Error(`the daemon exited (${daemon.exitCode}) while waiting for ${what}`);
    try {
      const found = await check();
      if (found) return found;
    } catch (err) {
      if (err.fatal) throw err;
      last = err.message;
    }
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`timed out after ${secs(t0)} waiting for ${what}${last ? ` (last error: ${last})` : ''}`);
    pokeRefresh();
    await sleep(POLL_MS);
  }
}

function expect(ok, what) {
  if (!ok) throw new Error(what);
}

const results = [];
let stepFailed = false;
async function step(name, fn) {
  const t0 = Date.now();
  console.log(`\n▶ ${name}`);
  try {
    await fn((line) => console.log(`    ${line}`));
  } catch (err) {
    results.push({ name, ok: false });
    stepFailed = true;
    console.log(`✗ ${name} (${secs(t0)}): ${err.message}`);
    throw err;
  }
  results.push({ name, ok: true });
  console.log(`✓ ${name} (${secs(t0)})`);
}

const prView = (url, fields) => ghJson('pr', 'view', url, '-R', REPO, '--json', fields);
const remoteBranches = () =>
  run('git', ['ls-remote', '--heads', 'origin'], { cwd: clonePath })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t')[1].replace('refs/heads/', ''));

function clearBranches(cwd, repo = REPO) {
  const open = ghJson('pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName').filter((p) =>
    isOurs(p.headRefName),
  );
  for (const p of open) gh('pr', 'close', String(p.number), '-R', repo);
  const branches = run('git', ['ls-remote', '--heads', 'origin'], { cwd })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t')[1].replace('refs/heads/', ''))
    .filter(isOurs);
  if (branches.length) run('git', ['push', '-q', 'origin', ...branches.map((b) => `:refs/heads/${b}`)], { cwd });
  return { prs: open.length, branches };
}

function addTask(title, prompt, ...flags) {
  const out = cli('add', '--repo', REPO_NAME, '--title', title, ...flags, prompt);
  const id = Number(/#(\d+)/.exec(out)?.[1]);
  expect(Number.isInteger(id), `agentdeck add printed no task id: ${out}`);
  return id;
}

async function prOpened(id, note, { label, base = 'main' }) {
  const task = await waitFor(`#${id} done with its PR open`, () => {
    const t = taskRow(id);
    if (['blocked', 'failed', 'cancelled'].includes(t.status)) throw fatal(`#${id} is ${t.status}: ${t.stop_reason}`);
    return t.status === 'done' && t.pr_url && t.pr_state === 'open' && t;
  });
  note(`db: #${id} done on ${task.branch}, pr_state open, ${task.pr_url}`);
  const pr = prView(task.pr_url, 'state,headRefName,baseRefName,labels,isDraft');
  expect(pr.state === 'OPEN', `GitHub says the PR is ${pr.state}`);
  expect(pr.headRefName === task.branch && pr.baseRefName === base, `the PR is ${pr.headRefName} → ${pr.baseRefName}, not into ${base}`);
  expect(!pr.isDraft, 'the PR is a draft, but pr_mode is ready');
  const labelled = pr.labels.some((l) => l.name === 'agentdeck:auto-merge');
  expect(labelled === label, `the PR ${labelled ? 'has' : 'lacks'} the agentdeck:auto-merge label`);
  note(`gh: PR open, ${pr.headRefName} → ${base}, ${label ? 'labelled agentdeck:auto-merge' : 'no auto-merge label'}`);
  return task.pr_url;
}

async function merged(id, url, note) {
  await waitFor(`#${id}'s PR merged on GitHub`, () => prView(url, 'state').state === 'MERGED');
  note('gh: PR merged');
  const task = await waitFor(`the daemon to record #${id}'s merge`, () => {
    const t = taskRow(id);
    return t.pr_state === 'merged' && t;
  });
  note(`db: #${id} ${task.status}, pr_state merged`);
  await waitFor(`${task.branch} deleted on GitHub`, () => !remoteBranches().includes(task.branch), 60_000);
  note(`gh: ${task.branch} deleted`);
  return task;
}

const mainOutput = () => Buffer.from(ghJson('api', `repos/${REPO}/contents/fake-output.txt?ref=main`).content, 'base64').toString('utf8');

console.log(`test:github on ${info.url} and ${REPO2}, scratch home ${HOME}`);
let failed = false;
const owned = new Set();

function resetRepo(repo, base, scratch, note) {
  gh('repo', 'clone', repo, scratch, '--', '-q');
  const git = (...args) => run('git', args, { cwd: scratch });
  if (git('ls-remote', '--heads', 'origin', base) !== '') {
    const commits = Number(git('rev-list', '--count', `origin/${base}`));
    const roots = git('rev-list', '--max-parents=0', `origin/${base}`).split('\n');
    const rootSubject = git('log', '-1', '--format=%s', roots[0]);
    if (commits > 1 && !(roots.length === 1 && rootSubject === RESET_SUBJECT))
      throw Object.assign(
        new Error(
          `${repo}'s ${base} has ${commits} commits and was not made by this script (its first commit is "${rootSubject}"): use a new, empty repo`,
        ),
        { refusal: true },
      );
  }
  owned.add(repo);
  const cleared = clearBranches(scratch, repo);
  note(`${repo}: closed ${cleared.prs} open PR(s), deleted ${cleared.branches.length} ${BRANCH_PREFIX} branch(es)`);
  git('checkout', '-q', '--orphan', 'e2e-reset');
  git('rm', '-rqf', '--ignore-unmatch', '.');
  writeFileSync(join(scratch, 'README.md'), README);
  mkdirSync(join(scratch, '.github/workflows'), { recursive: true });
  writeFileSync(join(scratch, '.github/workflows/agentdeck-e2e.yml'), WORKFLOW);
  git('add', 'README.md', '.github');
  git('-c', 'user.name=AgentDeck e2e', '-c', 'user.email=e2e@agentdeck.invalid', 'commit', '-qm', RESET_SUBJECT);
  try {
    git('push', '-q', '--force', 'origin', `HEAD:${base}`);
  } catch (err) {
    throw new Error(`${err.message}. A push that adds a workflow needs gh's workflow scope: gh auth refresh -s workflow`);
  }
  note(
    `${repo}: ${base} is ${git('rev-parse', '--short', 'HEAD')} "${RESET_SUBJECT}": README.md and a workflow with one check, ${CHECK_NAME}`,
  );
}

try {
  await step(`reset ${REPO} and ${REPO2}`, async (note) => {
    resetRepo(REPO, 'main', join(HOME, 'reset'), note);
    resetRepo(REPO2, REPO2_BASE, join(HOME, 'reset2'), note);
  });

  await step('register the repo on a scratch home and start the daemon', async (note) => {
    gh('repo', 'clone', REPO, clonePath, '--', '-q');
    run('git', ['config', 'user.name', 'AgentDeck e2e'], { cwd: clonePath });
    run('git', ['config', 'user.email', 'e2e@agentdeck.invalid'], { cwd: clonePath });
    cli('repo', 'add', clonePath, '--name', REPO_NAME);
    for (const [key, value] of [
      ['pr_mode', 'ready'],
      ['auto_merge', 'on'],
      ['auto_review', 'on'],
      ['auto_resolve', 'on'],
    ])
      cli('repo', 'set', REPO_NAME, key, value);
    cli('repo', 'resume', REPO_NAME);
    cli('set', 'planner_enabled', 'off');
    cli('set', 'reload_on_change', 'off');
    cli('set', 'max_concurrent', '2');
    const repo = database().prepare('SELECT * FROM repos WHERE name = ?').get(REPO_NAME);
    expect(
      repo.pr_mode === 'ready' && repo.auto_merge && repo.auto_review && repo.auto_resolve && !repo.test_cmd && !repo.paused_reason,
      `the repo is registered as ${JSON.stringify(repo)}`,
    );
    note(`db: ${REPO_NAME} at ${clonePath}, pr_mode ready, auto_merge, auto_review and auto_resolve on, no test command`);
    const log = [];
    daemon = spawn(process.execPath, [CLI, 'daemon'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (b) => {
      log.push(String(b));
      writeFileSync(DAEMON_LOG, log.join(''));
    };
    daemon.stdout.on('data', keep);
    daemon.stderr.on('data', keep);
    await waitFor('the daemon to start', () => log.join('').includes('agentdeck daemon'), 30_000);
    note(`daemon pid ${daemon.pid}, api on port ${port}, log ${DAEMON_LOG}`);
  });

  const first = addTask('e2e: the first task', 'FAKE_DONE FAKE_TWO_WAY write fake-output.txt');
  const second = addTask(
    'e2e: a task that conflicts with the first',
    'FAKE_DONE FAKE_TWO_WAY write fake-output.txt too',
    '--after',
    String(first),
  );
  cli('resume');
  let firstUrl = '';
  let secondUrl = '';

  await step(`#${first} done and its PR opened`, async (note) => {
    firstUrl = await prOpened(first, note, { label: true });
  });

  await step(`checks ran on #${first}'s PR`, async (note) => {
    const check = await waitFor(`the ${CHECK_NAME} check to pass on GitHub`, () => {
      const rollup = prView(firstUrl, 'statusCheckRollup').statusCheckRollup ?? [];
      const c = rollup.find((r) => r.name === CHECK_NAME);
      if (c?.status === 'COMPLETED' && c.conclusion !== 'SUCCESS') throw fatal(`${CHECK_NAME} ended ${c.conclusion}`);
      return c?.status === 'COMPLETED' && c;
    });
    note(`gh: ${check.name} ${check.conclusion.toLowerCase()} (${check.detailsUrl})`);
    const kept = await waitFor('the daemon to keep the passed check', () => {
      const stored = taskRow(first).pr_checks;
      return stored && JSON.parse(stored).checks.find((c) => c.name === CHECK_NAME && c.state === 'pass');
    });
    note(`db: #${first}'s pr_checks has ${kept.name} ${kept.state}`);
  });

  await step(`a review run read #${first}'s changes`, async (note) => {
    const review = await waitFor(`a review run's review of #${first}`, () => {
      const r = reviewsOf(first).find((x) => x.by === 'review_run' && x.submitted_at);
      const runs = runsOf(first, 'review');
      if (runs.some((x) => x.outcome && x.outcome !== 'done'))
        throw fatal(`a review run ended ${runs.find((x) => x.outcome !== 'done').outcome}`);
      return r && runs.some((x) => x.outcome === 'done') && r;
    });
    expect(review.kind === 'comment', `the review run asked for changes: ${review.body}`);
    note(`db: review run done, its review clean ("${review.body.split('\n')[0]}"), read at ${review.head_commit.slice(0, 7)}`);
    const { headRefOid } = prView(firstUrl, 'headRefOid');
    expect(headRefOid === review.head_commit, `the review read ${review.head_commit}, but the PR's head is ${headRefOid}`);
    note(`gh: the PR's head is the commit the review read`);
  });

  await step(`#${first} auto-merged`, async (note) => {
    await merged(first, firstUrl, note);
    expect(mainOutput().includes('done by fake claude'), "main's fake-output.txt is not the fake claude's");
    note(`gh: main has #${first}'s fake-output.txt`);
  });

  await step(`#${second} conflicts with main, a resolve run syncs it`, async (note) => {
    secondUrl = await prOpened(second, note, { label: true });
    const resolve = await waitFor(`a resolve run for #${second}`, () => {
      const runs = runsOf(second, 'resolve');
      if (runs.some((x) => x.outcome && x.outcome !== 'done'))
        throw fatal(`a resolve run ended ${runs.find((x) => x.outcome !== 'done').outcome}`);
      if (taskRow(second).pr_state === 'merged') throw fatal(`#${second} merged without a resolve run: it never conflicted`);
      return runs.find((x) => x.outcome === 'done');
    });
    note(`db: resolve run ${resolve.id} done`);
    const pushed = await waitFor(`#${second}'s PR to have the merge with main`, () => {
      const { headRefOid } = prView(secondUrl, 'headRefOid');
      const parents = ghJson('api', `repos/${REPO}/commits/${headRefOid}`).parents.length;
      return parents === 2 && headRefOid;
    });
    note(`gh: the PR's head ${pushed.slice(0, 7)} is a merge of main into the branch`);
  });

  await step(`#${second} merged`, async (note) => {
    await merged(second, secondUrl, note);
    const text = mainOutput();
    expect(!/^(<{7}|={7}|>{7})/m.test(text), "main's fake-output.txt has conflict markers");
    expect((text.match(/^run \d+$/gm) ?? []).length >= 2, "main's fake-output.txt lacks one task's side of the conflict");
    note("gh: main's fake-output.txt has both tasks' sides and no conflict markers");
    const reviewed = runsOf(second, 'review').filter((r) => r.outcome === 'done').length;
    note(`db: ${reviewed} review run(s) read #${second}'s changes`);
  });

  const third = addTask('e2e: a task whose PR a person closes', 'FAKE_DONE FAKE_TWO_WAY write fake-output.txt once more');
  cli('auto-merge', String(third), 'off');

  await step(`#${third}'s PR closed by hand`, async (note) => {
    const url = await prOpened(third, note, { label: false });
    gh('pr', 'close', url, '-R', REPO);
    note('gh pr close');
    await waitFor(`the daemon to record #${third}'s PR closed`, () => taskRow(third).pr_state === 'closed');
    note(`db: #${third} pr_state closed`);
    const t0 = Date.now();
    await waitFor('two more PR refreshes', () => Date.now() - t0 > 2 * POKE_MS + POLL_MS);
    const t = taskRow(third);
    expect(t.pr_state === 'closed' && t.pr_url === url, `#${third} now has pr_state ${t.pr_state} at ${t.pr_url}`);
    const prs = ghJson('pr', 'list', '-R', REPO, '--head', t.branch, '--state', 'all', '--json', 'url,state');
    const own = prs.find((p) => p.url === url);
    expect(own?.state === 'CLOSED', `GitHub says ${url} is ${own?.state ?? 'missing'}`);
    const open = prs.filter((p) => p.state === 'OPEN');
    expect(!open.length, `GitHub has an open PR for ${t.branch}: ${open.map((p) => p.url).join(', ')}`);
    note(`gh: the PR is closed and ${t.branch} has no other open; db: still closed, status ${t.status}`);
  });

  const planFile = join(HOME, 'e2e-plan.html');
  writeFileSync(planFile, PLAN_HTML);
  const planOwner = addTask(
    'e2e: plan step one',
    'FAKE_DONE FAKE_TWO_WAY write fake-output.txt for the plan',
    '--plan',
    planFile,
    '--steps',
    'one',
    '--propose',
  );
  const branchRow = () => database().prepare('SELECT * FROM plan_branches WHERE plan_task = ?').get(planOwner);
  cli('plan-branch', 'open', String(planOwner));
  const planName = branchRow()?.name;
  expect(planName?.startsWith(`plan/${planOwner}-`), `plan-branch open left ${JSON.stringify(branchRow())}`);
  const planSecond = addTask(
    'e2e: plan step two',
    'FAKE_DONE FAKE_TWO_WAY write fake-output.txt for the plan again',
    '--plan',
    String(planOwner),
    '--steps',
    'two',
    '--builds-on',
    String(planOwner),
    '--propose',
  );
  const planThird = addTask(
    'e2e: plan step three',
    'FAKE_DONE FAKE_TWO_WAY write fake-output.txt for the plan a third time',
    '--plan',
    String(planOwner),
    '--steps',
    'three',
    '--builds-on',
    String(planSecond),
    '--propose',
  );
  const planTasks = [planOwner, planSecond, planThird];
  for (const id of planTasks) {
    const target = taskRow(id).target;
    expect(target === planName, `#${id} targets ${target}, not ${planName}`);
  }
  cli('approve', ...planTasks.map(String));
  const scrubbed = (value) => JSON.stringify(value, null, 1).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'person@example.com');
  const record = (name, value) => {
    if (opts.record) writeFileSync(join(FIXTURES, `${name}.json`), `${scrubbed(value)}\n`);
  };
  const PR_FIELDS =
    'state,headRefOid,headRefName,baseRefName,isDraft,mergeable,mergeStateStatus,commits,additions,deletions,changedFiles,statusCheckRollup,files,labels';
  const planUrls = {};

  await step(`#${planOwner}'s PR opens into ${planName}, not main`, async (note) => {
    planUrls[planOwner] = await prOpened(planOwner, note, { label: true, base: planName });
    const pr = prView(planUrls[planOwner], PR_FIELDS);
    record('pr-view-plan-branch-task', pr);
    const checks = (pr.statusCheckRollup ?? []).map((c) => `${c.name} ${c.status}`);
    note(`gh: PR into ${pr.baseRefName} has ${checks.length ? checks.join(', ') : 'no checks'}`);
    expect(branchRow().status === 'active', `the plan branch is ${branchRow().status}, not active`);
    expect(remoteBranches().includes(planName), `${planName} is not on GitHub`);
    note(`db: ${planName} active; gh: ${planName} pushed`);
  });

  await step(`#${planOwner} merged into ${planName}`, async (note) => {
    await merged(planOwner, planUrls[planOwner], note);
    expect(remoteBranches().includes(planName), `${planName} was deleted when a task PR merged into it`);
    const { default_branch: def } = ghJson('api', `repos/${REPO}`);
    expect(def === 'main', `the default branch is ${def}`);
    note(`gh: ${planName} still there, main still the default branch`);
  });

  const runsDone = () => database().prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'plan_resolve' AND outcome = 'done'").get().n;
  let mainSha = '';

  await step(`a commit on main that conflicts with ${planName}, a resolve run syncs it`, async (note) => {
    const before = runsDone();
    const pusher = join(HOME, 'pusher');
    gh('repo', 'clone', REPO, pusher, '--', '-q');
    const git = (...args) =>
      run('git', ['-c', 'user.name=AgentDeck e2e', '-c', 'user.email=e2e@agentdeck.invalid', ...args], { cwd: pusher });
    writeFileSync(join(pusher, 'fake-output.txt'), 'changed on main behind the plan branch\n');
    git('commit', '-qam', 'e2e: a conflicting change on main');
    git('push', '-q', 'origin', 'HEAD:main');
    mainSha = git('rev-parse', 'HEAD');
    note(`gh: main is ${mainSha.slice(0, 7)}, with a change to fake-output.txt the plan branch also changed`);
    await waitFor('a resolve run for the plan branch', () => {
      const failedRun = database()
        .prepare("SELECT * FROM runs WHERE kind = 'plan_resolve' AND outcome IS NOT NULL AND outcome != 'done'")
        .get();
      if (failedRun) throw fatal(`a resolve run ended ${failedRun.outcome}`);
      return runsDone() > before;
    });
    note('db: a resolve run done');
    await waitFor(`${planName} to have main's commit`, () => {
      const cmp = ghJson('api', `repos/${REPO}/compare/${mainSha}...${planName}`);
      return cmp.behind_by === 0 && cmp.ahead_by > 0;
    });
    const status = branchRow().status;
    expect(status === 'active', `the plan branch is ${status} after its resolve, not active`);
    note(`gh: ${planName} contains main's ${mainSha.slice(0, 7)}; db: plan branch ${status}`);
  });

  await step(`#${planSecond} and #${planThird} merge into ${planName}`, async (note) => {
    for (const id of [planSecond, planThird]) {
      const task = await waitFor(`#${id} done with its PR`, () => {
        const t = taskRow(id);
        if (['blocked', 'failed', 'cancelled'].includes(t.status)) throw fatal(`#${id} is ${t.status}: ${t.stop_reason}`);
        return t.status === 'done' && t.pr_url && t;
      });
      const pr = prView(task.pr_url, 'headRefName,baseRefName');
      expect(pr.baseRefName === planName, `#${id}'s PR is ${pr.headRefName} → ${pr.baseRefName}, not into ${planName}`);
      note(`gh: #${id}'s PR is ${pr.headRefName} → ${planName}`);
      planUrls[id] = task.pr_url;
      await merged(id, planUrls[id], note);
    }
    expect(remoteBranches().includes(planName), `${planName} was deleted before it landed`);
  });

  await step(`${planName}'s PR opens into main and a person merges it`, async (note) => {
    const opened = await waitFor(`${planName}'s PR to open`, () => branchRow().pr_url && branchRow());
    expect(opened.status === 'landing', `the plan branch is ${opened.status}, not landing`);
    const pr = prView(opened.pr_url, PR_FIELDS);
    record('pr-view-plan-branch', pr);
    expect(pr.state === 'OPEN', `GitHub says the plan PR is ${pr.state}`);
    expect(pr.headRefName === planName && pr.baseRefName === 'main', `the plan PR is ${pr.headRefName} → ${pr.baseRefName}`);
    note(`gh: ${opened.pr_url} open, ${planName} → main`);
    gh('pr', 'merge', opened.pr_url, '-R', REPO, '--merge');
    note('gh pr merge, by a person');
    await waitFor('the daemon to record the plan branch landed', () => branchRow().status === 'landed');
    note(`db: ${planName} landed`);
    await waitFor(`${planName} deleted on GitHub`, () => !remoteBranches().includes(planName), 60_000);
    note(`gh: ${planName} deleted`);
    expect(mainOutput().includes('done by fake claude'), "main's fake-output.txt lacks the plan's work");
  });

  const clone2 = join(HOME, REPO2_NAME);
  await step(`register ${REPO2} with base ${REPO2_BASE} and squash merges; ${REPO_NAME} merges with merge commits`, async (note) => {
    gh('repo', 'clone', REPO2, clone2, '--', '-q');
    run('git', ['config', 'user.name', 'AgentDeck e2e'], { cwd: clone2 });
    run('git', ['config', 'user.email', 'e2e@agentdeck.invalid'], { cwd: clone2 });
    cli('repo', 'add', clone2, '--name', REPO2_NAME, '--base', REPO2_BASE);
    for (const [key, value] of [
      ['pr_mode', 'ready'],
      ['auto_merge', 'on'],
      ['merge_method', 'squash'],
    ])
      cli('repo', 'set', REPO2_NAME, key, value);
    cli('repo', 'resume', REPO2_NAME);
    cli('repo', 'set', REPO_NAME, 'merge_method', 'merge');
    const methods = database().prepare('SELECT name, base_branch, merge_method FROM repos ORDER BY id').all();
    note(`db: ${methods.map((r) => `${r.name} base ${r.base_branch}, ${r.merge_method}`).join('; ')}`);
  });

  const acrossFile = join(HOME, 'e2e-across.html');
  writeFileSync(acrossFile, PLAN_HTML.replace('E2E plan branch', 'E2E plan across repos'));
  const acrossOwner = addTask('e2e: across, the e2e part', 'FAKE_DONE FAKE_TWO_WAY write across.txt', '--plan', acrossFile, '--propose');
  const acrossOut = cli(
    'add',
    '--repo',
    REPO2_NAME,
    '--title',
    'e2e: across, the e2e2 part',
    '--plan',
    String(acrossOwner),
    '--propose',
    'FAKE_DONE FAKE_TWO_WAY write across.txt',
  );
  const acrossOther = Number(/#(\d+)/.exec(acrossOut)?.[1]);
  cli('plan-branch', 'open', String(acrossOwner));
  cli('plan-branch', 'policy', String(acrossOwner), 'in_order', `${REPO2_NAME},${REPO_NAME}`);
  const acrossRows = () =>
    database()
      .prepare(
        'SELECT plan_branches.*, repos.name AS repo FROM plan_branches JOIN repos ON repos.id = plan_branches.repo_id WHERE plan_task = ? ORDER BY land_order',
      )
      .all(acrossOwner);
  cli('approve', String(acrossOwner), String(acrossOther));

  await step(
    `an in_order plan across ${REPO_NAME} and ${REPO2_NAME} lands ${REPO2_NAME} first, then ${REPO_NAME}, each by its own method`,
    async (note) => {
      const rows = acrossRows();
      expect(
        rows.map((r) => `${r.repo}:${r.landing_policy}:${r.land_order}`).join(' ') === `${REPO2_NAME}:in_order:0 ${REPO_NAME}:in_order:1`,
        `the plan branches are ${JSON.stringify(rows)}`,
      );
      note(`db: ${rows.map((r) => `${r.name} in ${r.repo} on ${r.base}, in_order #${r.land_order + 1}`).join('; ')}`);
      for (const id of [acrossOwner, acrossOther]) {
        const task = await waitFor(`#${id} done with its PR`, () => {
          const t = taskRow(id);
          if (['blocked', 'failed', 'cancelled'].includes(t.status)) throw fatal(`#${id} is ${t.status}: ${t.stop_reason}`);
          return t.status === 'done' && t.pr_url && t;
        });
        await waitFor(`#${id}'s PR merged into its plan branch`, () => taskRow(id).pr_state === 'merged');
        note(`db: #${id} merged into ${task.target}`);
      }
      const landed = await waitFor('both plan branches landed', () => {
        const now = acrossRows();
        const stuck = now.find((r) => r.status === 'partly_landed' || r.land_error);
        if (stuck) throw fatal(`${stuck.name} in ${stuck.repo} is ${stuck.status}: ${stuck.land_error}`);
        return now.every((r) => r.status === 'landed') && now;
      });
      const prs = landed.map((r) => ({ ...r, pr: prView(r.pr_url, 'state,mergedAt,mergeCommit,baseRefName') }));
      const [first, second] = prs;
      expect(first.pr.baseRefName === REPO2_BASE && second.pr.baseRefName === 'main', 'the plan PRs are not into develop and main');
      expect(Date.parse(first.pr.mergedAt) <= Date.parse(second.pr.mergedAt), `${REPO_NAME} merged before ${REPO2_NAME}`);
      note(`gh: ${REPO2_NAME}'s plan PR merged at ${first.pr.mergedAt}, ${REPO_NAME}'s at ${second.pr.mergedAt}`);
      const parents = (repo, sha) => ghJson('api', `repos/${repo}/commits/${sha}`).parents.length;
      expect(parents(REPO2, first.pr.mergeCommit.oid) === 1, `${REPO2_NAME}'s plan PR did not squash`);
      expect(parents(REPO, second.pr.mergeCommit.oid) === 2, `${REPO_NAME}'s plan PR did not merge with a merge commit`);
      note(`gh: ${REPO2_NAME} squashed, ${REPO_NAME} merged with a merge commit`);
    },
  );
} catch (err) {
  if (err.refusal) {
    rmSync(HOME, { recursive: true, force: true });
    refuse(err.message);
  }
  failed = true;
  if (!stepFailed) console.log(`✗ ${err.message}`);
} finally {
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([new Promise((r) => daemon.on('exit', r)), sleep(10_000)]);
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
  }
  db?.close();
  for (const [repo, dir] of [
    [REPO, 'reset'],
    [REPO2, 'reset2'],
  ]) {
    if (!owned.has(repo)) continue;
    try {
      const cleared = clearBranches(join(HOME, dir), repo);
      console.log(`\ncleanup: ${repo}: closed ${cleared.prs} open PR(s), deleted ${cleared.branches.length} branch(es) on GitHub`);
    } catch (err) {
      failed = true;
      console.log(`\ncleanup of ${repo} failed: ${err.message}`);
    }
  }
}

console.log(
  `\n=== test:github on ${REPO}: ${results.filter((r) => r.ok).length} of ${results.length} steps passed in ${secs(started)} ===`,
);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
if (failed) {
  try {
    const tail = readFileSync(DAEMON_LOG, 'utf8').trim().split('\n').slice(-40).join('\n');
    console.log(`\nthe daemon's last lines:\n${tail}`);
  } catch {}
  console.log(`\nscratch home kept in ${HOME}`);
  process.exit(1);
}
if (opts.keep) console.log(`scratch home kept in ${HOME}`);
else rmSync(HOME, { recursive: true, force: true });
