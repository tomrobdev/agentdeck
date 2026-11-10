// Approving a proposal queues it. The only slot is #6's, so #5 stays queued instead of starting.
import { expect, group, open, row, rowIds, test } from '../fixtures';

test('approving a proposal queues it', async ({ page }) => {
  await open(page, '#/');
  await expect(row(page, 5)).toHaveClass(/\bs-proposed\b/);
  await row(page, 5).hover();
  await row(page, 5).getByRole('button', { name: 'Approve', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: /^Approve/ });
  const shows = (target: typeof dialog) =>
    target.waitFor({ state: 'visible', timeout: 2_000 }).then(
      () => true,
      () => false,
    );
  if (await shows(dialog)) {
    await dialog.locator('button.primary').click();
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    if (await shows(close)) await close.click();
  }

  await expect(row(page, 5)).toHaveClass(/\bs-queued\b/);
  await expect.poll(() => rowIds(group(page, 'Queued'))).toEqual([5]);
  await expect.poll(() => rowIds(group(page, 'Proposed'))).toEqual([]);
});
