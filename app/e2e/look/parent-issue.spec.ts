// Sub-issues under their parent issue: grouped in the list with their progress and where they merge, and on the task page.
import { expect, open, row, test } from '#e2e/fixtures.ts';

const parent = { number: 69, title: 'Order status' };
const merges_into = { branch: 'plan/9-order-status', plan: { task: 9, base: 'main', status: 'open', pr_url: null } };

test('the list groups sub-issues under their parent and says which branch they merge into', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agentdeck.display', JSON.stringify({ groupBy: 'parent', collapsed: [] })));
  await page.route(/\/api\/tasks$/, async (route) => {
    const res = await route.fetch();
    const tasks = (await res.json()) as { id: number }[];
    await route.fulfill({
      response: res,
      json: tasks.map((t) =>
        t.id === 4 || t.id === 5
          ? {
              ...t,
              source: 'issue',
              merges_into,
              issue: { number: 80 + t.id, url: `https://github.com/demo/demo/issues/${80 + t.id}`, parent },
            }
          : t,
      ),
    });
  });

  await open(page, '#/');
  const head = page.locator('[data-parent-head]').first();
  await expect(head).toContainText('GH #69');
  await expect(head).toContainText('0 of 2 done');
  await expect(head).toContainText('→ plan/9-order-status → main, one PR together');
  await expect(row(page, 5).locator('[data-issue-chip]')).toHaveText('GH #85');
  await expect(row(page, 1).locator('[data-issue-column]')).toBeEmpty();
  await page.getByPlaceholder('Search').fill('gh 85');
  await expect(page.locator('[data-task-row]')).toHaveCount(1);
  await page.getByPlaceholder('Search').fill('');

  await page.goto('/#/tasks/5/overview');
  const card = page.locator('[data-parent-card]');
  await expect(card).toContainText('Order status');
  await expect(card.locator('[data-issue-chip]')).toHaveText(['GH #84', 'GH #85']);
  await expect(card.locator('li')).toHaveCount(2);
  await expect(card.locator('[aria-current="true"]')).toContainText('Greet in French');
});
