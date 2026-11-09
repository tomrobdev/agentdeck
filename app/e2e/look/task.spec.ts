// A task page: its Overview with the plan, its run log (a finished run and a live one), and its diff in both layouts.
import { expect, open, test } from '../fixtures';

test("a task page's Overview shows the prompt, the pull request and the plan", async ({ page }) => {
  await open(page, '#/tasks/2/overview');
  await expect(page.getByRole('tab', { name: /Overview/ })).toHaveAttribute('data-state', 'active');
  await expect(page.getByText('Greet everyone', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('UI_GREET: greet everyone when no name is given').first()).toBeVisible();
  await expect(page.locator('[data-branch]')).toContainText('agentdeck/task-2');

  const plan = page.locator('article', { hasText: 'Friendlier greetings' });
  await expect(plan).toContainText('Greet everyone when no name is given');
  await expect(plan).toContainText('Greet a list of names');
  await expect(plan).toContainText('1/2');
});

test("a task page's run log shows what the run did", async ({ page }) => {
  await open(page, '#/tasks/2/runs');
  await expect(page.getByRole('tab', { name: /Runs/ })).toHaveAttribute('data-state', 'active');
  await expect(page.getByText('greet() now falls back to everyone, and greetAll() greets a list.').first()).toBeVisible();
  await expect(page.getByText('src/greet.ts').filter({ visible: true }).first()).toBeVisible();

  // Above the log: what the run was told, and the files its edits touched, each folded until opened.
  await expect(page.getByTestId('run-prompt').first()).toContainText('What this run was told');
  const touched = page.locator('details', { hasText: 'Files this run touched' });
  await touched.locator('summary').click();
  await expect(touched.getByText('src/greet.ts')).toBeVisible();
});

test('a running task opens on its live log', async ({ page }) => {
  await open(page, '#/tasks/6/runs');
  await expect(page.getByText('Writing the usage section, then the tests.').first()).toBeVisible({ timeout: 20_000 });
});

test('the diff shows unified, then split, then unified again', async ({ page }) => {
  await open(page, '#/tasks/2/changes');
  await expect(page.getByText('2 files', { exact: true })).toBeVisible();
  const diffs = page.locator('.diff');
  await expect(diffs).toHaveCount(2);
  await expect(diffs.first()).not.toHaveClass(/\bsplit\b/);
  await expect(page.locator('.diff').filter({ hasText: 'greetAll' })).toBeVisible();

  const layout = page.locator('[aria-label="Diff layout"]');
  await layout.getByText('Split', { exact: true }).click();
  await expect(diffs.first()).toHaveClass(/\bsplit\b/);
  // Side by side: a removed line on the left of a row and an added one on its right.
  const greet = page.locator('.diff.split').filter({ hasText: 'greetAll' });
  await expect(
    greet
      .locator('tr', { has: page.locator('td.code.half.del') })
      .locator('td.code.half.add')
      .first(),
  ).toBeVisible();
  await expect(greet.locator('td.code.half.del', { hasText: "return 'Hello, ' + name + '!';" })).toBeVisible();
  await expect(greet.locator('td.code.half.add', { hasText: 'return `Hello, ${who}!`;' })).toBeVisible();

  await layout.getByText('Unified', { exact: true }).click();
  await expect(diffs.first()).not.toHaveClass(/\bsplit\b/);
});
