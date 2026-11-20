// The repo and settings forms turn what the API sends into fields and back into a patch without losing a setting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepoDetail, Settings } from '#app/api/types.ts';
import { modelChoices, toRepoForm, toRepoPatch, toSettingsForm, toSettingsPatch } from '#app/lib/shared/forms.ts';
import { asRepoId } from '#domain/shared/index.ts';

const repo: RepoDetail = {
  id: asRepoId(3),
  name: 'shop',
  path: '/code/shop',
  base_branch: 'develop',
  test_cmd: 'composer check',
  allowed_tools: JSON.stringify(['Read', 'Bash(make *)']),
  tools_source: 'own',
  auto_approve: 0,
  proposed_at: null,
  toolchain: 'npm',
  setup_cmd: 'composer install',
  paused_reason: null,
  pr_mode: 'draft',
  merge_method: 'merge',
  auto_resolve: 1,
  auto_unblock: 0,
  auto_review: 1,
  sandbox: 1,
  network: JSON.stringify(['github.com']),
  archived_at: null,
  auto_merge: 1,
  auto_merge_max_lines: 300,
  auto_merge_skip: JSON.stringify(['.github/']),
  ci_not_run_ok: 0,
  code_comment_max_lines: 5,
  code_comment_max_percent: 5,
  union_paths: JSON.stringify(['docs/review-areas.md']),
  generated_paths: JSON.stringify(['docs/reference/**']),
  generated_cmd: 'pnpm docs:gen',
  model: null,
  created_at: '2026-11-01T00:00:00Z',
  goals: 'Ship it',
  goals_path: '/home/goals/shop.md',
  planner_runs: [],
};

test('a repo goes into the form and back into a patch with every setting it shows', () => {
  const form = toRepoForm(repo);
  assert.equal(form.baseBranch, 'develop');
  assert.equal(form.setupCmd, 'composer install');
  assert.equal(form.prMode, 'draft');
  assert.equal(form.autoReview, true);
  assert.equal(form.tools, 'Read\nBash(make *)');
  assert.deepEqual(toRepoPatch(form), {
    goals: 'Ship it',
    auto_approve: false,
    base_branch: 'develop',
    setup_cmd: 'composer install',
    test_cmd: 'composer check',
    pr_mode: 'draft',
    merge_method: 'merge',
    auto_resolve: true,
    auto_unblock: false,
    auto_review: true,
    auto_merge: true,
    auto_merge_max_lines: 300,
    auto_merge_skip: ['.github/'],
    ci_not_run_ok: false,
    code_comment_max_lines: 5,
    code_comment_max_percent: 5,
    union_paths: ['docs/review-areas.md'],
    generated_paths: ['docs/reference/**'],
    generated_cmd: 'pnpm docs:gen',
    sandbox: true,
    network: ['github.com'],
    model: null,
    allowed_tools: ['Read', 'Bash(make *)'],
  });
});

test('a repo with no generated command shows an empty field, and a blank one saves as none', () => {
  const form = toRepoForm({ ...repo, generated_cmd: undefined });
  assert.equal(form.generatedCmd, '');
  assert.equal(toRepoPatch({ ...form, generatedCmd: '  ' }).generated_cmd, null);
});

test('a setup command keeps its lines for the shell, and the base branch is trimmed', () => {
  const form = { ...toRepoForm(repo), setupCmd: 'npm ci &&\nnpm run build', baseBranch: ' main ' };
  const patch = toRepoPatch(form);
  assert.equal(patch.setup_cmd, 'npm ci &&\nnpm run build');
  assert.equal(patch.base_branch, 'main');
});

test('a repo from an older daemon, without the newer fields, gets their defaults', () => {
  const {
    auto_review: _r,
    auto_unblock: _u,
    ci_not_run_ok: _c,
    code_comment_max_lines: _l,
    code_comment_max_percent: _p,
    model: _m,
    ...old
  } = repo;
  const form = toRepoForm({ ...old, setup_cmd: null, test_cmd: null, allowed_tools: null });
  assert.equal(form.autoReview, false);
  assert.equal(form.setupCmd, '');
  assert.equal(form.tools, '');
  assert.equal(form.model, '');
  assert.deepEqual(toRepoPatch(form).allowed_tools, []);
});

test('settings go into the form as percentages and back as fractions', () => {
  const settings = {
    max_concurrent: 2,
    default_model: 'opus',
    support_model: 'sonnet',
    reload_on_change: false,
    budget: { five_hour_max: 0.95, five_hour_soft: 0.8, weekly_max: 0.9, pace_slack: 0.1 },
    notify: { desktop: true, events: ['done'], ntfy_topic: '' },
    planner: { enabled: false, interval_hours: 3, max_tasks: 3, model: 'opus' },
  } as Settings;
  const form = toSettingsForm(settings);
  assert.equal(form.five_hour_max, 95);
  assert.equal(form.pace_slack, 10);
  assert.deepEqual(toSettingsPatch(form), settings);
});

test('a model the list does not know is still offered, so the select can show it', () => {
  assert.ok(modelChoices('claude-custom-1').includes('claude-custom-1'));
  assert.ok(!modelChoices('opus').includes('claude-custom-1'));
  assert.deepEqual(modelChoices(null), modelChoices('opus'));
});
