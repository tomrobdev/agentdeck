import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DB_PATH, DEFAULTS } from './config.ts';
import { type Task, type TaskStatus, openDb } from './db.ts';
import { currentBranch, isGitRepo, removeWorktree } from './git.ts';
import { Scheduler } from './scheduler.ts';

const HELP = `agentdeck: always-on Claude Code task queue

Repos
  agentdeck repo add <path> [--name n] [--base main] [--test "npm test"] [--tools "Read,Edit,Bash(npm *)"]
  agentdeck repo ls

Tasks
  agentdeck add "<prompt>" --repo <name> [--title t] [--priority n] [--model sonnet] [--max-turns n] [--attempts n]
  agentdeck ls [--status queued|running|done|blocked|failed|cancelled]
  agentdeck show <id>
  agentdeck log <id> [--attempt n] [--raw]
  agentdeck cancel <id>
  agentdeck retry <id>
  agentdeck clean <id>          remove the task's worktree (its branch is kept)

Daemon
  agentdeck daemon              run the scheduler in the foreground
  agentdeck run-once            work the queue until empty, then exit (ignores pause)
  agentdeck pause | resume
  agentdeck status
  agentdeck set max_concurrent <n>
`;

const STATUS_ICON: Record<TaskStatus, string> = {
  queued: '·',
  running: '▶',
  done: '✓',
  blocked: '!',
  failed: '✗',
  cancel_requested: '⏹',
  cancelled: '⏹',
};

function die(msg: string): never {
  console.error(`agentdeck: ${msg}`);
  process.exit(1);
}

function taskId(arg: string | undefined): number {
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) die('expected a task id');
  return id;
}

function fmtTask(t: Task, repoName: string): string {
  const extra = t.blocked_reason && (t.status === 'blocked' || t.status === 'failed') ? `  — ${t.blocked_reason}` : '';
  return `${STATUS_ICON[t.status]} #${String(t.id).padEnd(4)} ${t.status.padEnd(9)} p${t.priority}  ${repoName.padEnd(14)} ${t.title}${extra}`;
}

function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** Turn a stream-json log into something readable. */
function printLog(path: string, raw: boolean): void {
  const text = readFileSync(path, 'utf8');
  if (raw) return void process.stdout.write(text);
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      console.log(line);
      continue;
    }
    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text.trim()) console.log(`\n💬 ${c.text.trim()}`);
        if (c.type === 'tool_use') console.log(`🔧 ${c.name} ${JSON.stringify(c.input).slice(0, 200)}`);
      }
    } else if (ev.type === 'result') {
      console.log(`\n── result: ${ev.subtype}, ${ev.num_turns} turns, $${(ev.total_cost_usd ?? 0).toFixed(3)} equiv ──`);
    } else if (ev.type === 'agentdeck_tests') {
      console.log(`\n── tests ${ev.passed ? 'passed' : 'FAILED'} ──\n${ev.output.slice(-3000)}`);
    } else if (ev.type === 'agentdeck_stderr' || ev.type === 'agentdeck_error') {
      console.log(`⚠️  ${ev.text.trim()}`);
    }
  }
}

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      base: { type: 'string' },
      test: { type: 'string' },
      tools: { type: 'string' },
      repo: { type: 'string', short: 'r' },
      title: { type: 'string', short: 't' },
      priority: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      'max-turns': { type: 'string' },
      attempts: { type: 'string' },
      status: { type: 'string', short: 's' },
      attempt: { type: 'string' },
      raw: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || flags.help || cmd === 'help') return void console.log(HELP);

  const db = openDb();
  const repoName = (id: number) => db.getRepo(id)?.name ?? `repo${id}`;

  switch (cmd) {
    case 'repo': {
      const [sub, path] = rest;
      if (sub === 'add') {
        if (!path) die('repo add needs a path');
        const abs = resolve(path);
        if (!existsSync(abs) || !(await isGitRepo(abs))) die(`${abs} is not a git repository`);
        const repo = db.addRepo({
          name: flags.name ?? basename(abs),
          path: abs,
          base_branch: flags.base ?? (await currentBranch(abs)),
          test_cmd: flags.test ?? null,
          allowed_tools: flags.tools ? flags.tools.split(',').map((s) => s.trim()) : null,
        });
        console.log(`added repo "${repo.name}" (${repo.path}, base ${repo.base_branch}${repo.test_cmd ? `, tests: ${repo.test_cmd}` : ''})`);
      } else if (sub === 'ls' || !sub) {
        for (const r of db.listRepos()) console.log(`${r.name.padEnd(16)} ${r.path}  base=${r.base_branch}  test=${r.test_cmd ?? '-'}`);
      } else die(`unknown repo command: ${sub}`);
      break;
    }

    case 'add': {
      const prompt = rest.join(' ').trim();
      if (!prompt) die('add needs a prompt');
      const repos = db.listRepos();
      const repo = flags.repo ? db.findRepo(flags.repo) : repos.length === 1 ? repos[0] : undefined;
      if (!repo) die(flags.repo ? `no repo "${flags.repo}"` : 'pass --repo (more than one repo registered)');
      const t = db.addTask({
        repo_id: repo.id,
        title: flags.title ?? prompt.split('\n')[0].slice(0, 80),
        prompt,
        priority: flags.priority ? Number(flags.priority) : undefined,
        model: flags.model,
        max_turns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
        max_attempts: flags.attempts ? Number(flags.attempts) : undefined,
      });
      console.log(`queued task #${t.id} on ${repo.name} (${t.model}, ${t.max_turns} turns max)`);
      if (db.isPaused()) console.log('note: the daemon is paused; run `agentdeck resume` to start working');
      break;
    }

    case 'ls': {
      const tasks = db.listTasks(flags.status as TaskStatus | undefined);
      if (!tasks.length) console.log('no tasks');
      for (const t of tasks) console.log(fmtTask(t, repoName(t.repo_id)));
      break;
    }

    case 'show': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      console.log(fmtTask(t, repoName(t.repo_id)));
      console.log(`model ${t.model}, attempts ${t.attempts}/${t.max_attempts}, max turns ${t.max_turns}`);
      if (t.branch) console.log(`branch   ${t.branch}`);
      if (t.worktree) console.log(`worktree ${t.worktree}`);
      console.log(`\n${t.prompt}\n`);
      for (const r of db.runsForTask(t.id)) {
        const tokens = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
        console.log(
          `run ${r.attempt}: ${r.outcome ?? 'running'}  turns=${r.num_turns ?? '-'}  tokens=${tokens}  tests=${r.tests_passed === null ? '-' : r.tests_passed ? 'pass' : 'fail'}  ${r.started_at}`,
        );
        if (r.result_text) console.log(`  ${r.result_text.trim().split('\n').slice(-6).join('\n  ')}`);
      }
      break;
    }

    case 'log': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      const runs = db.runsForTask(t.id);
      const run = flags.attempt ? runs.find((r) => r.attempt === Number(flags.attempt)) : runs.at(-1);
      if (!run) die('no runs yet');
      printLog(run.log_path, !!flags.raw);
      break;
    }

    case 'cancel': {
      const id = taskId(rest[0]);
      if (db.transitionTask(id, ['queued', 'blocked', 'failed'], 'cancelled')) console.log(`cancelled #${id}`);
      else if (db.transitionTask(id, ['running'], 'cancel_requested')) console.log(`stopping #${id}…`);
      else die(`#${id} can't be cancelled from its current state`);
      break;
    }

    case 'retry': {
      const id = taskId(rest[0]);
      const t = db.getTask(id) ?? die('no such task');
      if (!['blocked', 'failed', 'cancelled', 'done'].includes(t.status)) die(`#${id} is ${t.status}`);
      db.raw.prepare("UPDATE tasks SET status = 'queued', max_attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(id);
      console.log(`requeued #${id}`);
      break;
    }

    case 'clean': {
      const t = db.getTask(taskId(rest[0])) ?? die('no such task');
      if (t.status === 'running') die('task is running');
      if (!t.worktree) die('task has no worktree');
      await removeWorktree(db.getRepo(t.repo_id)!, t.worktree);
      db.updateTask(t.id, { worktree: null });
      console.log(`removed worktree; branch ${t.branch} kept`);
      break;
    }

    case 'pause':
      db.setSetting('paused', '1');
      console.log('paused: running tasks finish, no new ones start');
      break;

    case 'resume':
      db.setSetting('paused', '0');
      db.setSetting('rate_limited_until', '0');
      console.log('resumed');
      break;

    case 'set': {
      const [key, value] = rest;
      if (key !== 'max_concurrent' || !Number(value)) die('usage: agentdeck set max_concurrent <n>');
      db.setSetting(key, value);
      console.log(`${key} = ${value}`);
      break;
    }

    case 'status': {
      const counts = db.raw.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: string; n: number }[];
      const until = Number(db.getSetting('rate_limited_until', '0'));
      console.log(`state      ${db.isPaused() ? 'PAUSED' : 'active'}${until * 1000 > Date.now() ? ` (rate limited, resumes in ${relTime(until)})` : ''}`);
      console.log(`slots      ${db.countRunning()}/${db.maxConcurrent()} running`);
      console.log(`tasks      ${counts.map((c) => `${c.status} ${c.n}`).join(', ') || 'none'}`);
      for (const w of db.usageWindows()) {
        console.log(`usage      ${w.window.padEnd(10)} ${(w.utilization * 100).toFixed(0).padStart(3)}%  resets in ${relTime(w.resets_at)}  (seen ${w.observed_at} UTC)`);
      }
      console.log(`db         ${DB_PATH}`);
      break;
    }

    case 'daemon':
    case 'run-once': {
      const once = cmd === 'run-once';
      const scheduler = new Scheduler(db, { once });
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
          console.log(`${sig}: stopping workers; their tasks will be requeued on next start`);
          scheduler.stop();
          process.exit(0);
        });
      }
      console.log(`agentdeck ${once ? 'run-once' : 'daemon'}: ${db.isPaused() && !once ? 'PAUSED (agentdeck resume to start)' : 'active'}, max ${db.maxConcurrent()} concurrent, tick ${DEFAULTS.tickMs / 1000}s`);
      await scheduler.run();
      break;
    }

    default:
      die(`unknown command "${cmd}"\n\n${HELP}`);
  }
  db.close();
}

await main(process.argv.slice(2));
