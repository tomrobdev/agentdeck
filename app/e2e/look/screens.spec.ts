// The queue and a task page in light and dark, compared with the stored images (e2e/screenshots/), and the contrast of
// every piece of text on them. A theme or a style that leaks (like #152's :global() rule, which turned the page's text the
// colour of its background) changes the images and fails the contrast check.
import { type Mode, expect, lowContrast, open, queueSettled, test } from '../fixtures';

/** The pages to look at: what to open and what to wait for before the screenshot. */
const PAGES = [
  { name: 'queue', hash: '#/', ready: queueSettled },
  {
    name: 'task',
    hash: '#/tasks/2/overview',
    ready: (page) => expect(page.getByText('Friendlier greetings').first()).toBeVisible(),
  },
  {
    name: 'diff',
    hash: '#/tasks/2/changes',
    ready: (page) => expect(page.locator('.diff', { hasText: 'greetAll' })).toBeVisible(),
  },
  {
    name: 'run',
    hash: '#/tasks/2/runs',
    ready: (page) => expect(page.getByText('greet() now falls back to everyone').first()).toBeVisible(),
  },
] satisfies { name: string; hash: string; ready: (page: import('@playwright/test').Page) => Promise<void> }[];

for (const mode of ['light', 'dark'] as Mode[]) {
  test.describe(`in ${mode}`, () => {
    test.use({ mode });

    for (const p of PAGES) {
      test(`the ${p.name} page's text is readable`, async ({ page }) => {
        await open(page, p.hash);
        await p.ready(page);
        const low = await lowContrast(page);
        expect(low, `text under 4.5:1 on the ${p.name} page in ${mode}:\n${JSON.stringify(low, null, 1)}`).toEqual([]);
      });
    }

    for (const p of PAGES.filter((x) => x.name === 'queue' || x.name === 'task')) {
      test(`the ${p.name} page looks as it did`, async ({ page }) => {
        await open(page, p.hash);
        await p.ready(page);
        // Keep the pointer off the rows: hovering one selects it.
        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot(`${p.name}-${mode}.png`);
      });
    }
  });
}
