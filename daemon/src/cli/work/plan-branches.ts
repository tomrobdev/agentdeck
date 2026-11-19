// Plan branch commands: open and abandon a plan's plan branch.
import * as actions from '#application/actions.ts';
import { idsText, die, taskId } from '#cli/format.ts';
import type { Command } from '#cli/context.ts';
import type { RepoId } from '#domain/shared/index.ts';

export const planBranchCommands: Record<string, Command> = {
  'plan-branch': ({ db, rest }) => {
    const [sub, id] = rest;
    if ((sub !== 'open' && sub !== 'abandon') || !id) die('usage: agentdeck plan-branch open|abandon <plan task>');
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
    const abandoned = actions.abandonPlanBranch(db, taskId(id));
    for (const branch of [abandoned, ...abandoned.others]) {
      const moved = branch.moved.length ? `; ${idsText(branch.moved)} moved back to ${branch.base}` : '';
      console.log(`abandoned ${branch.name} in ${repoName(branch.repo_id)}${moved}`);
    }
  },
};
