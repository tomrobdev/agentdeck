// Operations shared by the CLI and the HTTP API. They throw ActionError on bad input.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Db, Repo, Task } from './db.ts';
import { currentBranch, isGitRepo } from './git.ts';

export class ActionError extends Error {}

export async function addRepo(
  db: Db,
  input: { path: string; name?: string; base?: string; test?: string | null; tools?: string[] | null },
): Promise<Repo> {
  const abs = resolve(input.path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(abs) || !(await isGitRepo(abs))) throw new ActionError(`${abs} is not a git repository`);
  try {
    return db.addRepo({
      name: input.name || basename(abs),
      path: abs,
      base_branch: input.base || (await currentBranch(abs)),
      test_cmd: input.test || null,
      allowed_tools: input.tools?.length ? input.tools : null,
    });
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new ActionError('a repo with that name or path is already registered');
    throw err;
  }
}

export function addTask(
  db: Db,
  input: { repo?: string; prompt: string; title?: string; priority?: number; model?: string; max_turns?: number; max_attempts?: number },
): Task {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new ActionError('a prompt is required');
  const repos = db.listRepos();
  const repo = input.repo ? db.findRepo(input.repo) : repos.length === 1 ? repos[0] : undefined;
  if (!repo) throw new ActionError(input.repo ? `no repo "${input.repo}"` : 'choose a repo (more than one is registered)');
  return db.addTask({
    repo_id: repo.id,
    title: input.title?.trim() || defaultTitle(prompt),
    prompt,
    priority: input.priority,
    model: input.model || undefined,
    max_turns: input.max_turns,
    max_attempts: input.max_attempts,
  });
}

/** First sentence of the prompt, cut at a word boundary. */
export function defaultTitle(prompt: string, max = 72): string {
  const first = prompt.split('\n')[0].trim();
  const sentence = first.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? first;
  if (sentence.length <= max) return sentence.replace(/\.$/, '');
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : max).replace(/[,;:\s]+$/, '')}…`;
}

/** Returns 'cancelled' for idle tasks, 'stopping' when a running worker has been asked to stop. */
export function cancelTask(db: Db, id: number): 'cancelled' | 'stopping' {
  if (db.transitionTask(id, ['queued', 'blocked', 'failed'], 'cancelled')) return 'cancelled';
  if (db.transitionTask(id, ['running'], 'cancel_requested')) return 'stopping';
  throw new ActionError(`#${id} can't be cancelled from its current state`);
}

export function retryTask(db: Db, id: number): void {
  const t = db.getTask(id);
  if (!t) throw new ActionError('no such task');
  if (!['blocked', 'failed', 'cancelled', 'done'].includes(t.status)) throw new ActionError(`#${id} is ${t.status}`);
  // One more attempt on top of what has been used.
  db.raw.prepare("UPDATE tasks SET status = 'queued', max_attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function setPaused(db: Db, paused: boolean): void {
  db.setSetting('paused', paused ? '1' : '0');
  if (!paused) db.setSetting('rate_limited_until', '0');
}

export function status(db: Db) {
  const counts = Object.fromEntries(
    (db.raw.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: string; n: number }[]).map((c) => [c.status, c.n]),
  );
  return {
    paused: db.isPaused(),
    rate_limited_until: Number(db.getSetting('rate_limited_until', '0')) || null,
    running: db.countRunning(),
    max_concurrent: db.maxConcurrent(),
    counts,
    usage: db.usageWindows(),
  };
}

/** A run's stream-json log reduced to what a person wants to read. */
export type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string };

export function parseLogLine(line: string): LogEntry[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? [{ kind: 'error', text: line }] : [];
  }
  switch (ev.type) {
    case 'assistant':
      return (ev.message?.content ?? []).flatMap((c: any): LogEntry[] => {
        if (c.type === 'text' && c.text.trim()) return [{ kind: 'text', text: c.text.trim() }];
        if (c.type === 'tool_use') return [{ kind: 'tool', name: c.name, input: JSON.stringify(c.input).slice(0, 400) }];
        return [];
      });
    case 'result':
      return [{ kind: 'result', subtype: ev.subtype, turns: ev.num_turns ?? 0, cost: ev.total_cost_usd ?? 0 }];
    case 'agentdeck_tests':
      return [{ kind: 'tests', passed: ev.passed, output: ev.output }];
    case 'agentdeck_stderr':
    case 'agentdeck_error':
      return [{ kind: 'error', text: String(ev.text).trim() }];
    default:
      return [];
  }
}

export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap(parseLogLine);
}
