// A merge from the merge dialog: #3 is in review with its checks passed and auto-merge off, so only a person merges it.
// The dialog asks the daemon to merge (a merge request), and the daemon merges it through the fake gh.
import { expect, group, open, row, rowIds, test } from '../fixtures';

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

  // The daemon merges on its next look at the PRs, a few seconds after the request.
  await expect(row(page, 3)).toContainText('PR merged', { timeout: 30_000 });
  await expect.poll(async () => (await rowIds(group(page, 'Done'))).sort()).toEqual([1, 3]);
});
