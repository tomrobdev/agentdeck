// The `agentdeck` command.
import { repoName as nameOfRepo } from '#application/actions.ts';
import { COMMANDS } from '#cli/commands.ts';
import { die } from '#cli/format.ts';
import { HELP } from '#cli/help.ts';
import { type CommandContext, parseCommandLine } from '#cli/context.ts';
import { composeApp } from '#src/compose.ts';

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseCommandLine(argv);
  const [cmd, ...rest] = positionals;
  if (!cmd || flags.help || cmd === 'help') return void console.log(HELP);
  const command = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!command) die(`unknown command "${cmd}"\n\n${HELP}`);

  const db = composeApp();
  const repoName: CommandContext['repoName'] = (id) => nameOfRepo(db, id);
  await command({ db, cmd, rest, flags, repoName });
  db.close();
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (process.env.AGENTDECK_DEBUG) console.error(err);
  die(err instanceof Error ? err.message.split('\n')[0] : String(err));
}
