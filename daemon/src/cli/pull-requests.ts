// Pull request commands: fix failing checks, close, merge and auto-merge.
import * as actions from '../application/actions.ts';
import { isReview, stageOf } from '../domain/task/stage.ts';
import { confirm, die, taskId } from './format.ts';
import type { Command } from './context.ts';

export const prCommands: Record<string, Command> = {
  'fix-checks': async ({ db, rest }) => {
    const id = taskId(rest[0]);
    const { checks } = await actions.fixChecks(db, id);
    console.log(
      `requeued #${id} to fix ${checks.length === 1 ? 'the failing check' : `${checks.length} failing checks`}: ${checks.join(', ')}`,
    );
  },
  'close-pr': async ({ db, rest }) => {
    const id = taskId(rest[0]);
    await actions.closeTaskPr(db, id);
    console.log(`closed the pull request of #${id}`);
  },
  merge: async ({ db, flags, rest }) => {
    if (flags.all) {
      const review = db.openPrTasks().filter((t) => isReview(stageOf(t)));
      if (!review.length) return void console.log('no pull requests in review');
      for (const t of review) console.log(`#${t.id}  ${t.title}`);
      if (!flags.yes && !(await confirm(`merge ${review.length === 1 ? 'this PR' : `these ${review.length} PRs`}?`))) {
        return void console.log('not merged');
      }
      const res = await actions.mergeAll(db, { ids: review.map((t) => t.id) });
      for (const m of res.merged) {
        console.log(
          `merged #${m.id} (${m.method})${m.unblocked.length ? `; ${m.unblocked.map((n) => `#${n}`).join(', ')} can start` : ''}`,
        );
        if (m.cleanup_error) console.log(`  cleanup incomplete: ${m.cleanup_error}`);
      }
      for (const s of res.skipped) console.log(`left #${s.id}: ${s.reason}`);
      return;
    }
    const id = taskId(rest[0]);
    const preview = await actions.mergePreview(db, id);
    const method = flags.method ?? preview.method;
    const { commits, files, additions, deletions, checks } = preview;
    console.log(`${preview.title}  #${id}`);
    console.log(`${preview.pr_url}`);
    console.log(
      `${preview.branch ?? '?'} → ${preview.base}, ${method}${method === 'squash' ? ` (${commits} → 1 commit)` : `, ${commits} commits`}`,
    );
    console.log(`${files} files, +${additions} −${deletions}`);
    const tests = preview.tests_passed === null ? 'not run' : preview.tests_passed ? 'passed' : 'FAILED';
    console.log(
      `tests ${tests}; GitHub checks: ${checks.total ? `${checks.total} (${checks.failing} failing, ${checks.pending} running)` : 'none'}`,
    );
    if (preview.unblocks.length) console.log(`unblocks ${preview.unblocks.map((t) => `#${t.id}`).join(', ')}`);
    for (const w of preview.warnings) console.log(`warning: ${w}`);
    for (const p of preview.problems) console.log(`problem: ${p}`);
    if (preview.problems.length) die(`can't merge #${id}`);
    if (!flags.yes && !(await confirm(`merge into ${preview.base} with ${method}?`))) return void console.log('not merged');
    const res = await actions.mergeTask(db, id, { method, delete_branch: !flags['keep-branch'] });
    console.log(
      `merged #${id} (${res.method})${res.unblocked.length ? `; ${res.unblocked.map((n) => `#${n}`).join(', ')} can start` : ''}`,
    );
    if (res.cleanup_error) console.log(`cleanup incomplete: ${res.cleanup_error}`);
  },
  'auto-merge': async ({ db, rest }) => {
    const id = taskId(rest[0]);
    const value = { on: true, off: false, repo: null }[rest[1] as 'on' | 'off' | 'repo'];
    if (value === undefined) die('usage: agentdeck auto-merge <id> on|off|repo');
    const res = await actions.setAutoMerge(db, id, { auto_merge: value });
    console.log(`#${id}: auto-merge ${res.auto_merge ? 'on' : 'off'}${value === null ? " (the repo's setting)" : ''}`);
    if (res.label_error) console.log(`could not change the PR's label: ${res.label_error}`);
  },
};
