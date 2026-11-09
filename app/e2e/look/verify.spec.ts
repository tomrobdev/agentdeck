// The approve dialog shows a task's latest verify run: its findings, false claims first and marked as false. The seed has
// no verify run (its only slot is #6's), so #5's detail is given one on the way to the page. It only reads: the dialog
// is closed, not confirmed, so #5 stays proposed for act/approve.spec.ts.
import { expect, open, row, test } from '../fixtures';

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

test('the approve dialog shows a verify run’s findings, a false one marked as false', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('agentdeck.approveDialog', JSON.stringify('always')));
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

  await open(page, '#/');
  await row(page, 5).hover();
  await row(page, 5).getByRole('button', { name: 'Approve', exact: true }).click();

  const dialog = page.getByRole('alertdialog', { name: /^Approve/ });
  await expect(dialog).toBeVisible();
  const list = dialog.locator('[data-verify-findings]');
  await expect(list).toContainText('2 claims: 1 true, 1 false at abc1234');
  const items = list.locator('[data-verdict]');
  await expect(items.first()).toHaveAttribute('data-verdict', 'false');
  await expect(items.first()).toContainText('✕ false');
  await expect(items.first()).toContainText('The queue is kept in Redis');
  await expect(items.first()).toContainText('Say the queue is an in-memory array');
  await expect(dialog.getByRole('button', { name: 'Verify again' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, 5)).toHaveClass(/\bs-proposed\b/);
});
