// The command table: every `agentdeck <command>`, by name. test/cli/cli-help.test.ts checks each one is in the help.
import { contextCommands } from './agent-context.ts';
import type { Command } from './context.ts';
import { daemonCommands } from './daemon.ts';
import { prCommands } from './pull-requests.ts';
import { repoCommands } from './repos.ts';
import { statsCommands } from './stats.ts';
import { taskCommands } from './tasks.ts';

export const COMMANDS: Record<string, Command> = {
  ...repoCommands,
  ...taskCommands,
  ...prCommands,
  ...daemonCommands,
  ...contextCommands,
  ...statsCommands,
};
