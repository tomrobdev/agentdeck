// Plan branch commands: open and abandon a plan's plan branch.
import * as actions from '#application/actions.ts';
import { idsText, die, taskId } from '#cli/format.ts';
import type { Command } from '#cli/context.ts';

export const planBranchCommands: Record<string, Command> = {
  'plan-branch': ({ db, rest }) => {
    const [sub, id] = rest;
    if ((sub !== 'open' && sub !== 'abandon') || !id) die('usage: agentdeck plan-branch open|abandon <plan task>');
    if (sub === 'open') {
      const branch = actions.openPlanBranch(db, taskId(id));
      const targeted = branch.targeted.length ? `; ${idsText(branch.targeted)} now target it` : '';
      console.log(`opened ${branch.name} for #${branch.plan_task}'s plan, from ${branch.base}${targeted}`);
      console.log('the daemon cuts and pushes it when the first task targeting it starts');
      return;
    }
    const branch = actions.abandonPlanBranch(db, taskId(id));
    const moved = branch.moved.length ? `; ${idsText(branch.moved)} moved back to ${branch.base}` : '';
    console.log(`abandoned ${branch.name}${moved}`);
  },
};
