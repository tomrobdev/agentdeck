import { type Mode, expect, lowContrast, open, queueSettled, test } from '#e2e/fixtures.ts';

const PAGES = [
  { name: 'queue', hash: '#/', ready: queueSettled },
  {
    name: 'task',
    hash: '#/tasks/2/overview',
    ready: async (page) => {
      await expect(page.getByText('Friendlier greetings').first()).toBeVisible();
      await expect(page.locator('.md .mermaid svg').first()).toBeVisible();
    },
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
  {
    name: 'settings',
    hash: '#/',
    ready: async (page) => {
      await queueSettled(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Usage budget' })).toBeVisible();
    },
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

    for (const p of PAGES.filter((x) => x.name === 'queue' || x.name === 'task' || x.name === 'settings')) {
      test(`the ${p.name} page looks as it did`, async ({ page }) => {
        await open(page, p.hash);
        await p.ready(page);
        await page.mouse.move(0, 0);
        await expect(page).toHaveScreenshot(`${p.name}-${mode}.png`);
      });
    }
  });
}
