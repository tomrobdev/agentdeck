// `agentdeck context`: the live queue in a few lines for an agent, and the mode Claude Code's hooks run it in.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as actions from '../application/actions.ts';
import { HOME } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Command } from './context.ts';
import { die } from './format.ts';

/** One cursor file per Claude session: the last event id that session was shown. */
const HOOK_DIR = join(HOME, 'hooks');
const HOOK_FILE_DAYS = 7;

/** What Claude Code passes a hook on stdin; only these fields are read. */
interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseHookInput(text: string): HookInput {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as HookInput) : {};
  } catch {
    return {};
  }
}

const cursorFile = (session: string) => join(HOOK_DIR, `${session.replace(/[^\w-]/g, '_')}.json`);

function readCursor(session: string): number | null {
  try {
    const v = (JSON.parse(readFileSync(cursorFile(session), 'utf8')) as { after?: unknown }).after;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

function writeCursor(session: string, after: number): void {
  mkdirSync(HOOK_DIR, { recursive: true });
  writeFileSync(cursorFile(session), JSON.stringify({ after }));
  const old = Date.now() - HOOK_FILE_DAYS * 86_400_000;
  for (const f of readdirSync(HOOK_DIR)) {
    const path = join(HOOK_DIR, f);
    if (statSync(path).mtimeMs < old) rmSync(path, { force: true });
  }
}

/**
 * The hook: prints nothing for workers and the planner, or outside a registered repo. A session's start (or its first
 * message) gets the whole picture; later messages get the header and what changed since. Never fails the prompt.
 */
async function hook(db: Db): Promise<void> {
  if (process.env.AGENTDECK_TASK_ID || process.env.AGENTDECK_PLANNER) return;
  try {
    const input = parseHookInput(await readStdin());
    const repo = actions.repoForPath(db, input.cwd ?? process.cwd());
    if (!repo) return;
    const session = input.session_id;
    const start = input.hook_event_name === 'SessionStart';
    const after = session && !start ? readCursor(session) : null;
    const ctx = await actions.liveContext(db, { repo, after, full: start });
    if (session) writeCursor(session, ctx.cursor);
    console.log(ctx.lines.join('\n'));
  } catch (err) {
    // A hook that fails would get in the way of every message; say why on stderr and carry on.
    console.error(`agentdeck context: ${(err as Error).message}`);
  }
}

export const contextCommands: Record<string, Command> = {
  context: async ({ db, flags }) => {
    if (flags.hook) return hook(db);
    const repo = flags.repo === undefined ? actions.repoForPath(db, process.cwd()) : db.findRepo(flags.repo);
    if (!repo) die(flags.repo === undefined ? 'not in a registered repo; pass --repo <name>' : `no repo "${flags.repo}"`);
    const since = flags.since === undefined ? null : Number(flags.since);
    if (since !== null && !Number.isInteger(since)) die('--since takes an event id, as the last line printed');
    const ctx = await actions.liveContext(db, { repo, after: since, full: true });
    console.log(ctx.lines.join('\n'));
    console.log(`(event ${ctx.cursor}: pass --since ${ctx.cursor} to see what changes after now)`);
  },
};
