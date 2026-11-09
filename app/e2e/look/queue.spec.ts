// The queue: every stage the seed made is in its group, and "need you" opens the tasks that wait on a person.
import { expandGroup, expect, group, open, queueSettled, row, rowIds, test } from '../fixtures';

test('the queue lists each stage in its group', async ({ page }) => {
  await open(page, '#/');
  await queueSettled(page);
  await expect.poll(() => rowIds(group(page, 'Needs you'))).toEqual([4]);
  await expect.poll(async () => (await rowIds(group(page, 'Review'))).sort()).toEqual([2, 3]);
  await expect.poll(() => rowIds(group(page, 'Proposed'))).toEqual([5]);
  await expect.poll(() => rowIds(group(page, 'Running'))).toEqual([6]);
  await expandGroup(page, 'Done');
  await expect.poll(() => rowIds(group(page, 'Done'))).toEqual([1]);

  // What each row says about its stage.
  await expect(row(page, 4)).toContainText('asks you');
  await expect(row(page, 2)).toContainText('Auto-merges when ready');
  await expect(row(page, 1)).toContainText('PR merged');
  await expect(row(page, 5)).toHaveClass(/\bs-proposed\b/);
});

test('"need you" opens the tasks that need a person', async ({ page }) => {
  await open(page, '#/');
  await queueSettled(page);
  const needYou = page.getByRole('banner').getByRole('button', { name: /need you/ });
  await expect(needYou).toContainText('4');
  await needYou.click();

  // The link filters the queue to those states (and puts the hash back to #/), so the list holds only the blocked task,
  // the two in review and the proposal: not the running or the merged one.
  await expect.poll(async () => (await rowIds(page.locator('[role="list"]'))).sort()).toEqual([2, 3, 4, 5]);
  await expect(row(page, 1)).toHaveCount(0);
  await expect(row(page, 6)).toHaveCount(0);
});
