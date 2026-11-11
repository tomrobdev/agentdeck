// A merge from the merge dialog: #3 is in review with its checks passed and auto-merge off, so only a person merges it.
import { expandGroup, expect, group, open, row, rowIds, test } from '#e2e/fixtures.ts';

test('a merge from the merge dialog lands the pull request', async ({ page }) => {
  await open(page, '#/');
  await expect(row(page, 3)).toBeVisible();
  await row(page, 3).hover();
  await row(page, 3).getByRole('button', { name: 'Merge', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Merge pull request' });
  await expect(dialog).toContainText('Document pop()');
  await expect(dialog).toContainText('agentdeck/task-3');
  await expect(dialog).toContainText('1 passing');
  const confirm = dialog.locator('button.primary');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('button', { name: /Done\s*2$/ })).toBeVisible({ timeout: 30_000 });
  await expandGroup(page, 'Done');
  await expect(row(page, 3)).toContainText('PR merged');
  await expect.poll(async () => (await rowIds(group(page, 'Done'))).sort()).toEqual([1, 3]);
});
