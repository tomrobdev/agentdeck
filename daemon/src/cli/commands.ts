// The command table: every `agentdeck <command>`, by name.
import { contextCommands } from '#cli/operations/agent-context.ts';
import type { Command } from '#cli/context.ts';
import { daemonCommands } from '#cli/operations/daemon.ts';
import { prCommands } from '#cli/landing/pull-requests.ts';
import { repoCommands } from '#cli/repos/repos.ts';
import { statsCommands } from '#cli/insights/stats.ts';
import { planBranchCommands } from '#cli/work/plan-branches.ts';
import { taskCommands } from '#cli/work/tasks.ts';

export const COMMANDS: Record<string, Command> = {
  ...repoCommands,
  ...taskCommands,
  ...planBranchCommands,
  ...prCommands,
  ...daemonCommands,
  ...contextCommands,
  ...statsCommands,
};
