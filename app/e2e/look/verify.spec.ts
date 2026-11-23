import type { Page } from '@playwright/test';
import { expect, open, row, test } from '#e2e/fixtures.ts';

const findings = [
  { claim: 'greet() lives in src/greet.ts', verdict: 'true', path: 'src/greet.ts', line: 2, evidence: 'It is there.', fix: null },
  {
    claim: 'The queue is kept in Redis',
    verdict: 'false',
    path: 'src/queue.ts',
    line: 3,
    evidence: 'It is an array in memory.',
    fix: 'Say the queue is an in-memory array',
  },
];

async function withVerifyRun(page: Page) {
  await page.route(/\/api\/tasks\/5$/, async (route) => {
    const res = await route.fetch();
    const task = await res.json();
    const at = new Date().toISOString();
    task.runs = [
      ...task.runs,
      {
        id: 9001,
        task_id: 5,
        kind: 'verify',
        attempt: 0,
        outcome: 'done',
        result_text: JSON.stringify({ findings }),
        base_commit: 'abc1234def5678',
        started_at: at,
        ended_at: at,
      },
    ];
    await route.fulfill({ response: res, json: task });
  });
}

test('the approve dialog shows a verify run’s findings, a false one marked as false', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agentdeck.approveDialog', JSON.stringify('always')));
  await withVerifyRun(page);

  await open(page, '#/');
  await row(page, 5).hover();
  await row(page, 5).getByRole('button', { name: 'Approve', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: /^Approve/ });
  await expect(dialog).toBeVisible();
  const list = dialog.locator('[data-verify-findings]');
  await expect(list).toContainText('✕ 1 false');
  await expect(list).toContainText('at abc1234');
  await expect(list.locator('[data-verdict="true"]')).toHaveCount(0);
  const items = list.locator('[data-verdict]');
  await expect(items.first()).toHaveAttribute('data-verdict', 'false');
  await expect(items.first()).toContainText('✕ false');
  await expect(items.first()).toContainText('The queue is kept in Redis');
  await expect(items.first()).toContainText('Say the queue is an in-memory array');
  await list.locator('[data-verdict-filter="true"]').click();
  await expect(items).toHaveCount(2);
  await expect(dialog.locator('[data-line]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Verify again' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, 5)).toHaveClass(/\bs-proposed\b/);
});

test("a proposal's findings show the code at the commit the verify run read, and open the file there", async ({ page }) => {
  const text = '// A queue\n// TODO: pick a store\nconst items: string[] = [];\n';
  const sha = 'abc1234def5678';
  await withVerifyRun(page);
  await page.route(/\/api\/tasks\/5\/file\?/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get('ref')).toBe('verify:9001');
    return route.fulfill({
      json: { path: q.get('path'), ref: q.get('ref'), sha, size: text.length, binary: false, truncated: false, text },
    });
  });
  await page.route(/\/api\/tasks\/5\/tree\?/, (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const entries = path
      ? [{ name: 'queue.ts', path: 'src/queue.ts', type: 'file', size: text.length }]
      : [{ name: 'src', path: 'src', type: 'dir', size: null }];
    return route.fulfill({ json: { ref: 'verify:9001', sha, path, entries } });
  });

  await page.goto('/#/tasks/5/overview');
  const finding = page.locator('[data-verify-findings] [data-verdict="false"]').first();
  await expect(finding.locator('[data-line="3"]')).toContainText('const items');
  await expect(finding.locator('[data-finding-code]')).toContainText('src/queue.ts:3');
  await finding.getByRole('link', { name: 'Open file' }).click();
  await expect(page.getByText('Verified at abc1234')).toBeVisible();
  await expect(page.locator('[data-line="3"]')).toContainText('const items');
});
