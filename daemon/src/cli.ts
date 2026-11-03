// The `agentdeck` command. The launchd plist runs this file, so it stays at src/cli.ts.
import { ActionError } from './application/actions.ts';
import { contextCommands } from './cli/agent-context.ts';
import { daemonCommands } from './cli/daemon.ts';
import { die } from './cli/format.ts';
import { HELP } from './cli/help.ts';
import { type Command, parseCommandLine } from './cli/context.ts';
import { prCommands } from './cli/pull-requests.ts';
import { repoCommands } from './cli/repos.ts';
import { statsCommands } from './cli/stats.ts';
import { taskCommands } from './cli/tasks.ts';
import { openDb } from './db/index.ts';

const COMMANDS: Record<string, Command> = {
  ...repoCommands,
  ...taskCommands,
  ...prCommands,
  ...daemonCommands,
  ...contextCommands,
  ...statsCommands,
};

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseCommandLine(argv);
  const [cmd, ...rest] = positionals;
  if (!cmd || flags.help || cmd === 'help') return void console.log(HELP);
  const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!command) die(`unknown command "${cmd}"\n\n${HELP}`);

  const db = openDb();
  const repoName = (id: number) => db.getRepo(id)?.name ?? `repo${id}`;
  await command({ db, cmd, rest, flags, repoName });
  db.close();
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof ActionError) die(err.message);
  throw err;
}
