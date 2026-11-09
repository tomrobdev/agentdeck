// A repo's tool rules, changed after `repo add`: `repo set <repo> tools "<rules>"` replaces them, "" goes back to the detected
// ones. The parsing is tested pure, then the whole of it with fake claude: the next run's --allowedTools follows the setting.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-repo-tools-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../fixtures/open-db.ts');
const { Scheduler } = await import('../../src/application/scheduler/scheduler.ts');
const { ActionError, repoView, updateRepo } = await import('../../src/application/actions.ts');
const { repoSettingPatch } = await import('../../src/cli/settings-args.ts');
const { DEFAULT_ALLOWED_TOOLS, parseToolRules, toolRulesSource } = await import('../../src/domain/repos/tools.ts');
const { toolRulesError } = await import('../../src/domain/repos/rules.ts');
const { toolchainTools } = await import('../../src/domain/repos/toolchain.ts');

// ---- pure

test('parseToolRules: commas and lines split rules, a comma in parentheses does not, blanks and repeats go', () => {
  assert.deepEqual(parseToolRules('Read, Edit,Bash(make *)'), ['Read', 'Edit', 'Bash(make *)']);
  assert.deepEqual(parseToolRules('Read\nBash(echo a, b)\n\n  Read  '), ['Read', 'Bash(echo a, b)']);
  assert.deepEqual(parseToolRules(''), []);
  assert.deepEqual(parseToolRules(' , \n'), []);
});

test('toolRulesError names the first rule that is not a tool name with an optional pattern', () => {
  assert.equal(toolRulesError(['Read', 'Bash(pnpm test*)', 'mcp__plane__workitem', 'WebFetch(domain:example.com)']), null);
  assert.match(toolRulesError(['Read', 'npm test'])!, /not a tool rule: npm test/);
  assert.match(toolRulesError(['Bash(make'])!, /not a tool rule: Bash\(make/);
});

test('toolRulesSource: own rules when the repo has them, else detected', () => {
  assert.equal(toolRulesSource({ allowed_tools: ['Read'] }), 'own');
  assert.equal(toolRulesSource({ allowed_tools: null }), 'detected');
});

// ---- with fake claude

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
git(dir, 'init', '-q', '-b', 'main');
git(dir, 'config', 'user.email', 'test@example.com');
git(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
git(dir, 'add', '-A');
git(dir, 'commit', '-q', '-m', 'init');
// A go repo with no setup command, so the detected rules are the defaults plus go's, and nothing reaches the network.
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', toolchain: 'go' });

const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
/** The --allowedTools of the last claude started. */
function lastAllowedTools(): string[] {
  const lines = readFileSync(join(home, 'fake-claude-args.log'), 'utf8').split('\n').filter(Boolean);
  const args: string[] = JSON.parse(lines.at(-1)!);
  return args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
}
async function runTask(title: string): Promise<string[]> {
  const task = db.addTask({ repo_id: repo.id, title, prompt: `${title}.` });
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');
  return lastAllowedTools();
}
// Edit and Write reach claude through the settings file, limited to the worktree, never as bare --allowedTools.
const DETECTED = [...DEFAULT_ALLOWED_TOOLS.filter((t) => t !== 'Edit' && t !== 'Write'), ...toolchainTools('go')];

test('repo set tools replaces the next run’s --allowedTools, and "" goes back to the detected rules', async () => {
  assert.deepEqual(await runTask('first'), DETECTED, 'a new repo runs with the detected rules');

  const own = updateRepo(db, 'demo', repoSettingPatch('tools', 'Read, Grep, Bash(make *)'));
  assert.deepEqual([own.allowed_tools, own.tools_source], ['["Read","Grep","Bash(make *)"]', 'own']);
  assert.deepEqual(await runTask('second'), ['Read', 'Grep', 'Bash(make *)']);

  const cleared = updateRepo(db, 'demo', repoSettingPatch('tools', ''));
  assert.deepEqual([cleared.allowed_tools, cleared.tools_source], [null, 'detected']);
  assert.equal(db.getRepo(repo.id)!.allowed_tools, null, 'cleared is null, not [] (which would allow nothing)');
  assert.deepEqual(await runTask('third'), DETECTED);
});

test('the settings API takes the rules as a list, and an empty list or null goes back to the detected rules', () => {
  assert.equal(updateRepo(db, repo.id, { allowed_tools: ['Read', 'Bash(go test*)'] }).allowed_tools, '["Read","Bash(go test*)"]');
  assert.equal(updateRepo(db, repo.id, { allowed_tools: [] }).tools_source, 'detected');
  updateRepo(db, repo.id, { allowed_tools: ['Read'] });
  assert.equal(updateRepo(db, repo.id, { allowed_tools: null }).tools_source, 'detected');
  assert.equal(repoView(db.getRepo(repo.id)!).allowed_tools, null);
});

test('a malformed rule is refused and leaves the rules as they were', () => {
  updateRepo(db, repo.id, { allowed_tools: ['Read'] });
  assert.throws(() => updateRepo(db, repo.id, repoSettingPatch('tools', 'Read, npm test')), ActionError);
  assert.throws(() => updateRepo(db, repo.id, { allowed_tools: [7] as never }), /allowed_tools must be a list of text/);
  assert.deepEqual(db.getRepo(repo.id)!.allowed_tools, ['Read']);
});
