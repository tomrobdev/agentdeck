// Pure tests of what a person may set on a repo, its tool rules and its protected edits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowedTools,
  editPathFor,
  isMergeMethod,
  isProtectedPath,
  parseToolRules,
  pausedReason,
  protectedEditTarget,
  protectedEditsMessage,
  repoNameError,
  toolRulesError,
  toolRulesSource,
} from '#domain/repos/index.ts';

test('a repo name may use letters, digits, dot, underscore and dash, and must not start with a dot or dash or be all digits', () => {
  assert.equal(repoNameError('my-repo_1.x'), null);
  assert.match(repoNameError('bad name') ?? '', /may only use letters/);
  assert.match(repoNameError('.hidden') ?? '', /must not start with a dot or dash/);
  assert.match(repoNameError('-dash') ?? '', /must not start with a dot or dash/);
  assert.match(repoNameError('123') ?? '', /all digits/);
  assert.equal(repoNameError('a123'), null);
});

test('a tool rule is a tool name with an optional pattern in parentheses', () => {
  assert.equal(toolRulesError(['Read', 'Bash(git status*)', 'mcp-x']), null);
  assert.match(toolRulesError(['Read', '9bad']) ?? '', /not a tool rule: 9bad/);
  assert.match(toolRulesError(['Bash git']) ?? '', /not a tool rule: Bash git/);
  assert.equal(toolRulesError([]), null);
});

test('parseToolRules splits on commas and newlines outside parentheses, trims and drops repeats', () => {
  assert.deepEqual(parseToolRules('Read, Bash(a, b)\nGrep,Read'), ['Read', 'Bash(a, b)', 'Grep']);
  assert.deepEqual(parseToolRules(''), []);
  assert.deepEqual(parseToolRules('Bash(a))), Edit'), ['Bash(a)))', 'Edit']);
});

test('a repo with rules of its own uses them; one without uses the defaults plus those its toolchain detects', () => {
  assert.equal(toolRulesSource({ allowed_tools: ['Read'] }), 'own');
  assert.equal(toolRulesSource({ allowed_tools: null }), 'detected');
  const root = { files: ['Cargo.toml'], scripts: [] };
  assert.deepEqual(allowedTools({ allowed_tools: ['Read'], toolchain: null }, root), ['Read']);
  const detected = allowedTools({ allowed_tools: null, toolchain: null }, root);
  assert.ok(detected.includes('Read') && detected.includes('Bash(cargo test*)'));
  const named = allowedTools({ allowed_tools: null, toolchain: 'uv' }, root);
  assert.ok(named.includes('Bash(uv run *)') && !named.includes('Bash(cargo test*)'));
  const none = allowedTools({ allowed_tools: null, toolchain: null }, { files: [], scripts: [] });
  assert.ok(none.includes('Read') && !none.some((t) => t.startsWith('Bash(cargo')));
});

test('only the known merge methods are merge methods', () => {
  assert.ok(isMergeMethod('squash'));
  assert.ok(!isMergeMethod('fast-forward'));
  assert.ok(!isMergeMethod(null));
});

test('the daemon being paused outranks the repo being paused, and a repo with no reason is not paused', () => {
  assert.equal(pausedReason(true, { paused_reason: 'x' }), 'AgentDeck is paused');
  assert.equal(pausedReason(false, { paused_reason: 'ci red' }), 'the repo is paused: ci red');
  assert.equal(pausedReason(false, { paused_reason: null }), null);
});

test('a protected path is under .claude/; its edit lives in .agentdeck/edits without the leading dot', () => {
  assert.ok(isProtectedPath('.claude/skills/x/SKILL.md'));
  assert.ok(!isProtectedPath('src/a.ts'));
  assert.equal(editPathFor('.claude/skills/x/SKILL.md'), '.agentdeck/edits/claude/skills/x/SKILL.md');
  assert.equal(editPathFor('docs/a.md'), '.agentdeck/edits/docs/a.md');
});

test('protectedEditTarget maps an edit path back to its target and refuses anything unsafe or never applied', () => {
  assert.deepEqual(protectedEditTarget('claude/skills/x/SKILL.md'), { target: '.claude/skills/x/SKILL.md' });
  assert.deepEqual(protectedEditTarget('.claude/rules/a.md'), { target: '.claude/rules/a.md' });
  const refused = (p: string) => ('refused' in protectedEditTarget(p) ? (protectedEditTarget(p) as { refused: string }).refused : null);
  assert.equal(refused(''), 'empty path');
  assert.equal(refused('/etc/passwd'), 'absolute path');
  assert.equal(refused('C:/x'), 'absolute path');
  assert.equal(refused('claude\\x'), 'backslash in path');
  assert.match(refused('claude/../x') ?? '', /leaves the edits folder/);
  assert.match(refused('claude//x') ?? '', /empty or "\." segment/);
  assert.match(refused('src/a.ts') ?? '', /not under \.claude\//);
  assert.match(refused('claude/settings.json') ?? '', /never applied/);
  assert.match(refused('claude/hooks/pre.sh') ?? '', /never applied/);
});

test('the protected-edits commit message lists the paths', () => {
  assert.equal(protectedEditsMessage(['.claude/a.md', '.claude/b.md']), 'Apply protected edits: .claude/a.md, .claude/b.md');
});
