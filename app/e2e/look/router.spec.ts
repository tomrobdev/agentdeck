// The router: unknown paths and tabs redirect, the window title follows the route, and Back restores the queue's scroll.
import { expect, open, row, test } from '../fixtures';

test('an unknown path lands on the queue', async ({ page }) => {
  await open(page, '#/nowhere/at/all');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  await expect(page).toHaveTitle('Queue — AgentDeck');
});

test('an unknown task tab lands on Overview', async ({ page }) => {
  await page.goto('/#/tasks/1/nope');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/tasks/1/overview');
});

test('the window title follows the route', async ({ page }) => {
  await open(page, '#/');
  await expect(page).toHaveTitle('Queue — AgentDeck');
  await page.goto('/#/insights');
  await expect(page).toHaveTitle('Insights — AgentDeck');
  await page.goto('/#/tasks/1');
  await expect(page).toHaveTitle(/^#1 .+ — AgentDeck$/);
});

test('Back to the queue keeps its scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await open(page, '#/');
  const list = page.locator('[data-scroll="queue"]');
  await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate((el) => (el.scrollTop = 80));
  const before = await list.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);

  await page.evaluate(() => (location.hash = '#/insights'));
  await expect(page).toHaveTitle('Insights — AgentDeck');
  await page.goBack();
  await expect(row(page, 6)).toBeAttached();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(before);
});
