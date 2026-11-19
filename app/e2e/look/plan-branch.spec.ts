import { expect, open, test } from '#e2e/fixtures.ts';

test('a task merged into a plan branch waits for it to land, and the plan card shows the plan branch', async ({ page }) => {
  await page.route(/\/api\/tasks\/2$/, async (route) => {
    const res = await route.fetch();
    const task = await res.json();
    const name = 'plan/2-friendlier-greetings';
    const at = new Date().toISOString();
    await route.fulfill({
      response: res,
      json: {
        ...task,
        status: 'done',
        pr_state: 'merged',
        target: name,
        plan_landing: { name, base: 'main', state: 'waiting' },
        plan_branch: {
          id: 1,
          plan_task: 2,
          repo_id: task.repo_id,
          name,
          base: 'main',
          status: 'landing',
          head_commit: 'abc1234',
          pr_url: 'https://github.com/demo/demo/pull/9',
          created_at: at,
          updated_at: at,
          ahead: 3,
          behind: 1,
        },
      },
    });
  });

  await open(page, '#/tasks/2/overview');
  await expect(page.getByText('waiting to land').first()).toBeVisible();
  await expect(page.getByText('merged into plan/2-friendlier-greetings, waiting for it to land').first()).toBeVisible();

  const branch = page.locator('[data-plan-branch]');
  await expect(branch).toContainText('plan/2-friendlier-greetings');
  await expect(branch).toContainText('landing');
  await expect(branch).toContainText('3 ahead, 1 behind main');
  await expect(branch.getByRole('button', { name: /PR into main/ })).toBeVisible();
});
