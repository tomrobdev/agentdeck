// Plan branch commands: open and abandon a plan's plan branch, set its landing policy, and answer a plan that landed in only some repos.
import * as actions from '#application/actions.ts';
import { idsText, die, taskId } from '#cli/format.ts';
import type { Command } from '#cli/context.ts';
import type { RepoId } from '#domain/shared/index.ts';

const USAGE = [
  'usage: agentdeck plan-branch open|abandon <plan task>',
  '       agentdeck plan-branch policy <plan task> person|auto|together|in_order [repo,repo,...]',
  '       agentdeck plan-branch question <plan task>',
  '       agentdeck plan-branch answer <plan task> retry|revert|by_hand',
].join('\n');

export const planBranchCommands: Record<string, Command> = {
  'plan-branch': async ({ db, rest }) => {
    const [sub, id, arg, order] = rest;
    if (!sub || !id || !['open', 'abandon', 'policy', 'question', 'answer'].includes(sub)) die(USAGE);
    const names = new Map(actions.listRepos(db).map((r) => [r.id, r.name]));
    const repoName = (repo: RepoId) => names.get(repo) ?? `repo ${repo}`;
    if (sub === 'open') {
      const opened = actions.openPlanBranch(db, taskId(id));
      for (const branch of [opened, ...opened.others]) {
        const targeted = branch.targeted.length ? `; ${idsText(branch.targeted)} now target it` : '';
        console.log(`opened ${branch.name} in ${repoName(branch.repo_id)} for #${branch.plan_task}'s plan, from ${branch.base}${targeted}`);
      }
      console.log('the daemon cuts and pushes each when the first task targeting it starts');
      return;
    }
    if (sub === 'policy') {
      const branches = actions.setPlanLandingPolicy(db, taskId(id), { policy: arg, order: order ? order.split(',') : [] });
      for (const b of branches) {
        const place = b.land_order === null ? '' : `, number ${b.land_order + 1} in its order`;
        console.log(`${b.name} in ${repoName(b.repo_id)} lands ${b.landing_policy}${place}`);
      }
      return;
    }
    if (sub === 'question') {
      const { question } = actions.planLandingQuestion(db, taskId(id));
      if (!question) return console.log(`#${id}'s plan is not partly landed`);
      console.log(question.text);
      for (const o of question.options) console.log(`  ${o.answer}: ${o.text}`);
      return;
    }
    if (sub === 'answer') {
      const done = await actions.answerPlanLanding(db, taskId(id), { answer: arg });
      for (const b of done.branches) console.log(`${b.name} in ${repoName(b.repo_id)}: ${b.status}`);
      for (const r of done.reverts) console.log(`opened a revert PR in ${r.repo}: ${r.url}`);
      for (const r of done.unreverted) console.log(`could not open a revert PR in ${r}: revert it by hand`);
      return;
    }
    const abandoned = actions.abandonPlanBranch(db, taskId(id));
    for (const branch of [abandoned, ...abandoned.others]) {
      const moved = branch.moved.length ? `; ${idsText(branch.moved)} moved back to ${branch.base}` : '';
      console.log(`abandoned ${branch.name} in ${repoName(branch.repo_id)}${moved}`);
    }
  },
};
