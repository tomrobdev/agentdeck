// The command table: every `agentdeck <command>`, by name. test/cli-help.test.ts checks each one is in the help.
import { contextCommands } from './operations/agent-context.ts';
import type { Command } from './context.ts';
import { daemonCommands } from './operations/daemon.ts';
import { prCommands } from './landing/pull-requests.ts';
import { repoCommands } from './repos/repos.ts';
import { statsCommands } from './insights/stats.ts';
import { taskCommands } from './work/tasks.ts';

export const COMMANDS: Record<string, Command> = {
  ...repoCommands,
  ...taskCommands,
  ...prCommands,
  ...daemonCommands,
  ...contextCommands,
  ...statsCommands,
};
