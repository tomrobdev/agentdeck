// A task from a GitHub issue: its title and prompt are edited on the issue, so the task page and the approve dialog link there instead.
import { expect, open, row, test } from '#e2e/fixtures.ts';

const issue = { number: 9, url: 'https://github.com/demo/demo/issues/9' };

test("an issue's proposal is edited on GitHub, from its page and from the approve dialog", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agentdeck.approveDialog', JSON.stringify('always')));
  await page.route(/\/api\/tasks\/5$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), source: 'issue', issue } });
  });

  await page.goto('/#/tasks/5/overview');
  await expect(page.locator('[data-edit-on-github]')).toBeVisible();
  await expect(page.locator('[data-issue-chip]').first()).toHaveText('GH #9');
  await expect(page.getByRole('heading', { level: 1 }).getByRole('textbox')).toHaveCount(0);

  await open(page, '#/');
  await row(page, 5).hover();
  await row(page, 5).getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: /^Approve/ });
  await expect(dialog.locator('[data-edit-on-github]')).toBeVisible();
  await expect(dialog.locator('[data-issue-chip]')).toHaveText('GH #9');
  await expect(dialog.getByRole('button', { name: 'Edit prompt' })).toHaveCount(0);
});
