// What every CLI command gets: the parsed command line and the database.
import { parseArgs } from 'node:util';
import type { Db } from '../db/index.ts';
import type { RepoId } from '../domain/shared/index.ts';

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
      'builds-on': { type: 'string' },
      plan: { type: 'string' },
      steps: { type: 'string' },
      status: { type: 'string', short: 's' },
      sort: { type: 'string' },
      attempt: { type: 'string' },
      note: { type: 'string' },
      raw: { type: 'boolean' },
      archived: { type: 'boolean' },
      method: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'keep-branch': { type: 'boolean' },
      all: { type: 'boolean' },
      propose: { type: 'boolean' },
      file: { type: 'string' },
      now: { type: 'boolean' },
      follow: { type: 'boolean', short: 'f' },
      lines: { type: 'string', short: 'n' },
      since: { type: 'string' },
      by: { type: 'string' },
      hook: { type: 'boolean' },
      json: { type: 'boolean' },
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
  repoName: (id: RepoId) => string;
}

export type Command = (ctx: CommandContext) => void | Promise<void>;
