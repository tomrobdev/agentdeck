// Operations shared by the CLI and the HTTP API. They throw ActionError on bad input.
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { type Db, PR_MODES, type PrMode, type Repo, type Task } from './db.ts';
import { type Check, runDoctor } from './doctor.ts';
import { detectToolchain } from './domain/toolchain.ts';
import { currentBranch, isGitRepo, rootInfo } from './git.ts';
import { BUDGET_KEYS, type Budget, decide, validateBudget } from './governor.ts';
import { NOTIFY_KINDS, type NotifyKind, type NotifySettings, notify, notifySettings } from './notify.ts';
import { pauseRepo } from './pause.ts';
import { type PlannerSettings, goalsPath, planRepo, plannerSettings, readGoals, writeGoals } from './planner.ts';

export class ActionError extends Error {}

/** Register a repo. Its toolchain is detected from the root files and fills in whatever isn't given. */
export async function addRepo(
  db: Db,
  input: { path: string; name?: string; base?: string; test?: string | null; setup?: string | null; tools?: string[] | null },
): Promise<Repo> {
  const abs = resolve(input.path.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(abs) || !(await isGitRepo(abs))) throw new ActionError(`${abs} is not a git repository`);
  const { files, scripts } = rootInfo(abs);
  const detected = detectToolchain(files, scripts);
  try {
    return db.addRepo({
      name: input.name || basename(abs),
      path: abs,
      base_branch: input.base || (await currentBranch(abs)),
      test_cmd: input.test || detected?.test_cmd || null,
      // Left null unless given, so the rules follow the repo's scripts as they change (worker.effectiveTools).
      allowed_tools: input.tools?.length ? input.tools : null,
      toolchain: detected?.toolchain ?? null,
      setup_cmd: input.setup || detected?.setup_cmd || null,
    });
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new ActionError('a repo with that name or path is already registered');
    throw err;
  }
}

export function addTask(
  db: Db,
  input: {
    repo?: string;
    prompt: string;
    title?: string;
    priority?: number;
    model?: string;
    max_turns?: number;
    max_attempts?: number;
    after_task?: number;
  },
): Task {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new ActionError('a prompt is required');
  if (input.after_task !== undefined && (!Number.isInteger(input.after_task) || !db.getTask(input.after_task)))
    throw new ActionError(`--after: no task #${input.after_task}`);
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
    after_task: input.after_task,
  });
}

const EDITABLE = ['proposed', 'queued', 'blocked', 'failed'];

/** Change a waiting or unsuccessful task's title, prompt, priority, model, turn limit or attempt limit. */
export function editTask(
  db: Db,
  id: number,
  patch: { title?: string; prompt?: string; priority?: number; model?: string; max_turns?: number; max_attempts?: number },
): Task {
  const task = db.getTask(id);
  if (!task) throw new ActionError('no such task');
  const fields: Parameters<Db['editTask']>[1] = {};

  const text = (key: 'title' | 'prompt' | 'model') => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value !== 'string' || !value.trim()) throw new ActionError(`${key} cannot be empty`);
    fields[key] = value.trim();
  };
  const whole = (key: 'priority' | 'max_turns' | 'max_attempts', min: number, max: number) => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
      throw new ActionError(`${key} must be a whole number from ${min} to ${max}`);
    fields[key] = value;
  };
  text('title');
  text('prompt');
  text('model');
  whole('priority', -1000, 1000);
  whole('max_turns', 1, 500);
  whole('max_attempts', 1, 20);

  if (!Object.keys(fields).length) throw new ActionError('nothing to change');
  const edited = db.editTask(id, fields);
  if (!edited) {
    const now = db.getTask(id)?.status ?? task.status;
    throw new ActionError(`#${id} is ${now}; only ${EDITABLE.join(', ')} tasks can be edited`);
  }
  return edited;
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
  const t = db.applyEvent(id, { type: 'cancel' });
  if (!t) throw new ActionError(`#${id} can't be cancelled from its current state`);
  return t.status === 'cancel_requested' ? 'stopping' : 'cancelled';
}

/** Accept a planner proposal into the queue. */
export function approveTask(db: Db, id: number): void {
  if (!db.applyEvent(id, { type: 'approve' })) throw new ActionError(`#${id} is not a proposal`);
}

export function rejectTask(db: Db, id: number): void {
  if (!db.applyEvent(id, { type: 'reject' })) throw new ActionError(`#${id} is not a proposal`);
}

function repoOrThrow(db: Db, nameOrId: string | number) {
  const repo = db.findRepo(String(nameOrId));
  if (!repo) throw new ActionError(`no repo "${nameOrId}"`);
  return repo;
}

export function repoDetail(db: Db, nameOrId: string | number) {
  const repo = repoOrThrow(db, nameOrId);
  return { ...repo, goals: readGoals(repo), goals_path: goalsPath(repo), planner_runs: db.plannerRuns(repo.id, 5) };
}

export function updateRepo(
  db: Db,
  nameOrId: string | number,
  patch: {
    goals?: string;
    auto_approve?: boolean;
    test_cmd?: string | null;
    setup_cmd?: string | null;
    base_branch?: string;
    pr_mode?: PrMode;
  },
) {
  const repo = repoOrThrow(db, nameOrId);
  if (patch.pr_mode !== undefined && !PR_MODES.includes(patch.pr_mode))
    throw new ActionError(`pr_mode must be one of ${PR_MODES.join(', ')}`);
  if (patch.base_branch !== undefined && !patch.base_branch.trim()) throw new ActionError('base_branch cannot be empty');
  if (patch.goals !== undefined) {
    if (patch.goals.length > 20_000) throw new ActionError('goals are limited to 20,000 characters');
    writeGoals(repo, patch.goals);
  }
  db.updateRepo(repo.id, {
    ...(patch.auto_approve !== undefined ? { auto_approve: patch.auto_approve ? 1 : 0 } : {}),
    ...(patch.test_cmd !== undefined ? { test_cmd: patch.test_cmd?.trim() || null } : {}),
    ...(patch.setup_cmd !== undefined ? { setup_cmd: patch.setup_cmd?.trim() || null } : {}),
    ...(patch.base_branch !== undefined ? { base_branch: patch.base_branch.trim() } : {}),
    ...(patch.pr_mode !== undefined ? { pr_mode: patch.pr_mode } : {}),
  });
  return repoDetail(db, repo.id);
}

/** Let a paused repo's tasks run again. */
export function resumeRepo(db: Db, nameOrId: string | number): Repo {
  const repo = repoOrThrow(db, nameOrId);
  db.setRepoPaused(repo.id, null);
  return db.getRepo(repo.id)!;
}

export interface DoctorReport {
  repo: string;
  ok: boolean;
  checks: Check[];
  paused_reason: string | null;
}

/**
 * Check that a repo is ready for unattended runs. A failure pauses the repo, naming the first failed check;
 * a pass clears any pause.
 */
export async function doctorRepo(db: Db, nameOrId: string | number): Promise<DoctorReport> {
  const repo = repoOrThrow(db, nameOrId);
  const checks = await runDoctor(repo);
  const failed = checks.find((c) => !c.ok);
  if (failed) pauseRepo(db, repo, `doctor: ${failed.name}`, { replace: true });
  else db.setRepoPaused(repo.id, null);
  return { repo: repo.name, ok: !failed, checks, paused_reason: db.getRepo(repo.id)!.paused_reason };
}

const planning = new Set<number>();

/** Run the planner for one repo now, regardless of its schedule. */
export async function planNow(db: Db, nameOrId: string | number) {
  const repo = repoOrThrow(db, nameOrId);
  if (planning.has(repo.id)) throw new ActionError(`already planning ${repo.name}`);
  planning.add(repo.id);
  try {
    return await planRepo(db, repo);
  } finally {
    planning.delete(repo.id);
  }
}

export function retryTask(db: Db, id: number): void {
  const t = db.getTask(id);
  if (!t) throw new ActionError('no such task');
  // One more attempt on top of what has been used.
  if (!db.applyEvent(id, { type: 'retry' })) throw new ActionError(`#${id} is ${t.status}`);
}

export function setPaused(db: Db, paused: boolean): void {
  db.setSetting('paused', paused ? '1' : '0');
  if (!paused) db.setSetting('rate_limited_until', '0');
}

export function status(db: Db) {
  const counts = Object.fromEntries(
    (db.raw.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: string; n: number }[]).map((c) => [
      c.status,
      c.n,
    ]),
  );
  return {
    paused: db.isPaused(),
    rate_limited_until: Number(db.getSetting('rate_limited_until', '0')) || null,
    running: db.countRunning(),
    max_concurrent: db.maxConcurrent(),
    counts,
    usage: db.usageWindows(),
    governor: decide(db.usageWindows(), db.budget(), db.maxConcurrent()),
    budget: db.budget(),
    notifications: db.recentNotifications(10),
  };
}

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: NotifySettings;
  planner: PlannerSettings;
}

export function getSettings(db: Db): Settings {
  return { max_concurrent: db.maxConcurrent(), budget: db.budget(), notify: notifySettings(db), planner: plannerSettings(db) };
}

/** Apply a partial settings update after validating all of it. */
export function updateSettings(
  db: Db,
  patch: { max_concurrent?: number; budget?: Partial<Budget>; notify?: Partial<NotifySettings>; planner?: Partial<PlannerSettings> },
): Settings {
  const writes: [string, string][] = [];

  if (patch.max_concurrent !== undefined) {
    const n = Number(patch.max_concurrent);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new ActionError('max_concurrent must be a whole number from 1 to 8');
    writes.push(['max_concurrent', String(n)]);
  }

  if (patch.budget) {
    const merged = { ...db.budget() };
    for (const k of BUDGET_KEYS) if (patch.budget[k] !== undefined) merged[k] = Number(patch.budget[k]);
    const err = validateBudget(merged);
    if (err) throw new ActionError(err);
    for (const k of BUDGET_KEYS) writes.push([k, String(merged[k])]);
  }

  if (patch.notify) {
    const n = patch.notify;
    if (n.desktop !== undefined) writes.push(['notify_desktop', n.desktop ? '1' : '0']);
    if (n.events !== undefined) {
      const bad = n.events.filter((e) => !NOTIFY_KINDS.includes(e as NotifyKind));
      if (bad.length) throw new ActionError(`unknown notification events: ${bad.join(', ')}`);
      writes.push(['notify_events', n.events.join(',')]);
    }
    if (n.ntfy_topic !== undefined) {
      const topic = n.ntfy_topic.trim();
      if (topic && !/^[\w-]{1,64}$/.test(topic)) throw new ActionError('ntfy topic: letters, digits, - and _ only');
      writes.push(['ntfy_topic', topic]);
    }
    if (n.ntfy_server !== undefined) {
      if (!/^https?:\/\/\S+$/.test(n.ntfy_server)) throw new ActionError('ntfy server must be an http(s) URL');
      writes.push(['ntfy_server', n.ntfy_server]);
    }
  }

  if (patch.planner) {
    const p = patch.planner;
    if (p.enabled !== undefined) writes.push(['planner_enabled', p.enabled ? '1' : '0']);
    if (p.interval_hours !== undefined) {
      const h = Number(p.interval_hours);
      if (!(h >= 0.25 && h <= 168)) throw new ActionError('planner interval must be between 0.25 and 168 hours');
      writes.push(['planner_interval_hours', String(h)]);
    }
    if (p.max_tasks !== undefined) {
      const n = Number(p.max_tasks);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new ActionError('planner max tasks must be a whole number from 1 to 10');
      writes.push(['planner_max_tasks', String(n)]);
    }
    if (p.model !== undefined) {
      if (!['haiku', 'sonnet', 'opus'].includes(p.model)) throw new ActionError('planner model must be haiku, sonnet or opus');
      writes.push(['planner_model', p.model]);
    }
  }

  for (const [k, v] of writes) db.setSetting(k, v);
  return getSettings(db);
}

export function sendTestNotification(db: Db): Promise<void> {
  return notify(db, { kind: 'test', title: 'Test notification', body: 'Notifications from AgentDeck are working.' });
}

/** A run's stream-json log reduced to what a person wants to read. */
export type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
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
    case 'agentdeck_setup':
      return [{ kind: 'setup', passed: ev.passed, cmd: ev.cmd, output: ev.output }];
    case 'agentdeck_tests':
      return [{ kind: 'tests', passed: ev.passed, output: ev.output }];
    case 'agentdeck_pr':
      return [ev.error ? { kind: 'error', text: `pull request: ${ev.error}` } : { kind: 'text', text: `Opened pull request ${ev.url}` }];
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
