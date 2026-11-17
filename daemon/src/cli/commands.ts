// The command table: every `agentdeck <command>`, by name.
import { contextCommands } from '#cli/operations/agent-context.ts';
import type { Command } from '#cli/context.ts';
import { daemonCommands } from '#cli/operations/daemon.ts';
import { prCommands } from '#cli/landing/pull-requests.ts';
import { repoCommands } from '#cli/repos/repos.ts';
import { statsCommands } from '#cli/insights/stats.ts';
import { taskCommands } from '#cli/work/tasks.ts';

export const COMMANDS: Record<string, Command> = {
  ...repoCommands,
  ...taskCommands,
  ...prCommands,
  ...daemonCommands,
  ...contextCommands,
  ...statsCommands,
};
