import { type Locator, type Page, expect, test as base } from '@playwright/test';

export { expect };
export type Mode = 'light' | 'dark';

const CLOCK_AHEAD_MS = 3 * 86_400_000;

export const test = base.extend<{ mode: Mode }>({
  mode: ['light', { option: true }],
  page: async ({ page, mode }, use) => {
    await page.clock.setFixedTime(new Date(Date.now() + CLOCK_AHEAD_MS));
    await page.addInitScript((m) => localStorage.setItem('agentdeck.mode', JSON.stringify(m)), mode);
    await use(page);
  },
});

export async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator('[data-task-row], [data-branch]').first()).toBeVisible();
}

export const row = (page: Page, id: number): Locator => page.locator(`[data-task-row="${id}"]`);

export const group = (page: Page, label: string): Locator =>
  page.locator('[role="list"] > section').filter({ has: page.getByRole('button', { name: new RegExp(`${label}\\s*\\d+$`) }) });

export async function expandGroup(page: Page, label: string): Promise<void> {
  const header = page.getByRole('button', { name: new RegExp(`${label}\\s*\\d+$`) });
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

export const rowIds = (scope: Locator): Promise<number[]> =>
  scope.locator('[data-task-row]').evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-task-row'))));

export async function queueSettled(page: Page): Promise<void> {
  await expect(row(page, 6)).toHaveClass(/\bs-running\b/, { timeout: 20_000 });
  await expect(row(page, 2)).toContainText('Auto-merges when ready', { timeout: 20_000 });
}

export interface LowContrast {
  text: string;
  ratio: number;
  color: string;
  background: string;
}

export function lowContrast(page: Page): Promise<LowContrast[]> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], below: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + below[i] * (1 - top[3]));
    const luminance = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const backdrop = (el: Element): number[] => {
      const layers: [number, number, number, number][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] >= 1) break;
      }
      return layers.reduceRight<number[]>((below, top) => over(top, below), [255, 255, 255]);
    };
    const opacity = (el: Element) => {
      let o = 1;
      for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const fmt = (c: number[]) => `rgb(${c.map((v) => Math.round(v)).join(' ')})`;

    const found: { text: string; ratio: number; color: string; background: string }[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const text = node.textContent?.trim();
      if (!el || !text || seen.has(el)) continue;
      seen.add(el);
      if (el.closest('script, style, noscript, :disabled, [aria-disabled="true"], [aria-hidden="true"]')) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const background = backdrop(el);
      const [r, g, b, a] = rgba(style.color);
      const color = over([r, g, b, a * opacity(el)], background);
      const [hi, lo] = [luminance(color), luminance(background)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < (large ? 3 : 4.5))
        found.push({ text: text.slice(0, 60), ratio: Math.round(ratio * 100) / 100, color: fmt(color), background: fmt(background) });
    }
    return found;
  });
}
