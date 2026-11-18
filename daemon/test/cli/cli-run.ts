// Runs `agentdeck <args>` in this process against a scratch database, and captures what it prints, how it exits and its exit code.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ports } from '#application/ports/app.ts';
import { testApp } from '#test/fixtures/fixtures.ts';

process.env.AGENTDECK_HOME ??= mkdtempSync(join(tmpdir(), 'agentdeck-cli-run-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { COMMANDS } = await import('#cli/commands.ts');
const { parseCommandLine } = await import('#cli/context.ts');
const { repoName } = await import('#application/actions.ts');

export interface CliResult {
  out: string;
  err: string;
  exit: number | null;
}

export function scratchCli(ports: Partial<Ports> = {}) {
  const db = testApp(openDb(':memory:'), ports);
  const run = async (...args: string[]): Promise<CliResult> => {
    const { values: flags, positionals } = parseCommandLine(args);
    const [cmd, ...rest] = positionals;
    const out: string[] = [];
    const err: string[] = [];
    const saved = { log: console.log, error: console.error, exit: process.exit, exitCode: process.exitCode };
    console.log = (...a: unknown[]) => void out.push(a.join(' '));
    console.error = (...a: unknown[]) => void err.push(a.join(' '));
    let exit: number | null = null;
    process.exit = ((code?: number) => {
      exit = code ?? 0;
      throw new Error(`exit ${code}`);
    }) as never;
    process.exitCode = undefined;
    try {
      await COMMANDS[cmd]({ db, cmd, rest, flags, repoName: (id) => repoName(db, id) });
    } catch (e) {
      if (exit === null) {
        err.push(`agentdeck: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        exit = 1;
      }
    } finally {
      Object.assign(console, { log: saved.log, error: saved.error });
      process.exit = saved.exit;
      if (exit === null && process.exitCode !== undefined) exit = Number(process.exitCode);
      process.exitCode = saved.exitCode;
    }
    return { out: out.join('\n'), err: err.join('\n'), exit };
  };
  return { db, run };
}

export function scratchRepo(name = 'demo'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agentdeck-cli-repo-')), name);
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'n');
  writeFileSync(join(path, 'README.md'), 'hi\n');
  git('add', '.');
  git('commit', '-m', 'init');
  return path;
}
