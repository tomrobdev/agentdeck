import { expect, open, test } from '#e2e/fixtures.ts';

const pane = (task_id: number, title: string, run_id: number, extra: Record<string, unknown> = {}) => ({
  run_id,
  task_id,
  title,
  kind: 'work',
  model: 'sonnet',
  started_at: '2026-01-01 10:00:00',
  turns: 7,
  max_turns: 60,
  tool: `Edit file${task_id}.ts`,
  lines: [`reading file${task_id}.ts`, `Edit file${task_id}.ts`],
  ...extra,
});

test('the Running view shows a pane per running run, drops one that ends, and opens its task', async ({ page }) => {
  let live = [pane(1, 'First running task', 9001), pane(2, 'Second running task', 9002, { kind: 'review', turns: 3, max_turns: 30 })];
  await page.route(/\/api\/runs\/live$/, (route) => route.fulfill({ json: live }));

  await open(page, '#/');
  await page.getByTitle('Running (v)').click();

  const panes = page.locator('[data-run-pane]');
  await expect(panes).toHaveCount(2);
  await expect(panes.first()).toContainText('First running task');
  await expect(panes.first().locator('[data-run-turns]')).toHaveText('7 of 60 turns');
  await expect(panes.first().locator('[data-run-tool]')).toHaveText('Edit file1.ts');
  await expect(panes.nth(1)).toContainText('Second running task');
  await expect(panes.nth(1).locator('[data-run-turns]')).toHaveText('3 of 30 turns');
  await expect(panes.nth(1)).toContainText('Review run');

  live = [pane(2, 'Second running task', 9002), pane(3, 'Third running task', 9003)];
  await expect(panes.first()).toContainText('Second running task');
  await expect(page.getByText('First running task')).toHaveCount(0);
  await expect(page.getByText('Third running task')).toBeVisible();

  await panes.first().click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/tasks\/2\//);
});

test('the Running view says so when nothing runs', async ({ page }) => {
  await page.route(/\/api\/runs\/live$/, (route) => route.fulfill({ json: [] }));
  await open(page, '#/');
  await page.getByTitle('Running (v)').click();
  await expect(page.getByText('Nothing is running.')).toBeVisible();
});
