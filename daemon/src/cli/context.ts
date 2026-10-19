// What every CLI command gets: the parsed command line and the database.
import { parseArgs } from 'node:util';
import type { Db } from '../db/index.ts';

export function parseCommandLine(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      base: { type: 'string' },
      test: { type: 'string' },
      setup: { type: 'string' },
      tools: { type: 'string' },
      prompt: { type: 'string' },
      repo: { type: 'string', short: 'r' },
      title: { type: 'string', short: 't' },
      priority: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'max-turns': { type: 'string' },
      attempts: { type: 'string' },
      after: { type: 'string' },
      status: { type: 'string', short: 's' },
      sort: { type: 'string' },
      attempt: { type: 'string' },
      note: { type: 'string' },
      raw: { type: 'boolean' },
      method: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'keep-branch': { type: 'boolean' },
      file: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

export interface CommandContext {
  db: Db;
  /** The command name, as typed. */
  cmd: string;
  /** Positional arguments after the command name. */
  rest: string[];
  flags: ReturnType<typeof parseCommandLine>['values'];
  repoName: (id: number) => string;
}

export type Command = (ctx: CommandContext) => void | Promise<void>;
