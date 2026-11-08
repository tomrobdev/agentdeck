// The parsers and the fakes, checked against real `claude` and `gh` output recorded in daemon/test/fixtures/ by
// daemon/scripts/record-fixtures.mjs. First each recording goes through what reads it (the claude adapter, the run log,
// the live state, classifyRun; parsePrDetails, the checks parser, the log tail) and what they read out is checked. Then
// fake-claude.mjs and fakeCodeHost are run, and every event and field the parsers read must be in their output with the
// shape it has in the recording it stands for. When claude or gh changes, re-record: these tests say what moved.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runClaude } from '../src/adapters/claude.ts';
import { LOG_TAIL_BYTES, actionsRun, logTail, parsePrDetails, type PrDetails } from '../src/domain/landing/index.ts';
import {
  type ClaudeRun,
  type LogEntry,
  START_LIVE,
  classifyRun,
  firstDenial,
  nextLive,
  parseLogLine,
  resultFields,
} from '../src/domain/runs/index.ts';
import type { UsageWindow } from '../src/domain/runs/run.ts';
import { fakeCodeHost } from './fakes.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const FAKE = join(import.meta.dirname, 'fake-claude.mjs');
const ZERO_ID = '00000000-0000-0000-0000-000000000000';

const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-contracts-'));
// A stand-in claude that prints a recording as it was recorded, so the real adapter reads real output.
const REPLAY = join(scratch, 'replay-claude.sh');
writeFileSync(REPLAY, '#!/bin/sh\ncat "$AGENTDECK_REPLAY"\n');
chmodSync(REPLAY, 0o755);
chmodSync(FAKE, 0o755);
// The fake commits what it writes, so it runs in a repo of its own.
const repo = join(scratch, 'repo');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
execFileSync('mkdir', ['-p', repo]);
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
writeFileSync(join(repo, 'README.md'), '# README\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

/** What one claude process left, read the way the daemon reads it: the adapter's run, its log lines, entries, usage and live state. */
interface Captured {
  run: ClaudeRun;
  lines: string[];
  events: any[];
  entries: LogEntry[];
  usage: UsageWindow[];
  live: typeof START_LIVE;
}

async function capture(bin: string, args: string[], env: Record<string, string>): Promise<Captured> {
  process.env.AGENTDECK_CLAUDE_BIN = bin;
  const lines: string[] = [];
  const usage: UsageWindow[] = [];
  let live = START_LIVE;
  const log = {
    write(text: string) {
      lines.push(...text.split('\n').filter(Boolean));
      return true;
    },
  } as unknown as WriteStream;
  const run = await runClaude({ args, cwd: repo, log, env, onUsage: (w) => usage.push(w), onEvent: (ev) => (live = nextLive(live, ev)) });
  const events = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  return { run, lines, events, entries: lines.flatMap(parseLogLine), usage, live };
}

const replay = (fixture: string) => capture(REPLAY, [], { AGENTDECK_REPLAY: join(FIXTURES, 'claude', `${fixture}.jsonl`) });
const fakeRun = (prompt: string, extra: string[] = []) =>
  capture(FAKE, ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...extra], { AGENTDECK_HOME: scratch });
const kinds = (entries: LogEntry[]) => entries.map((e) => e.kind);

// ── claude: the recordings through the parsers ──────────────────────────────────────────────────────────────────────

test('done-with-tool: the session, usage, live line, log entries and result fields read out of a real run', async () => {
  const c = await replay('done-with-tool');
  assert.equal(c.run.sessionId, ZERO_ID);
  assert.deepEqual(c.usage, [
    { window: 'five_hour', utilization: 0.34, resets_at: 1794169800, status: 'allowed' },
    { window: 'seven_day', utilization: 0.29, resets_at: 1794178800, status: 'allowed' },
  ]);
  assert.equal(c.run.rateLimitedUntil, undefined);
  assert.deepEqual(c.live, { turns: 2, message: 'msg_011Cgqsdee2edVfBQWgbC9sU', tool: 'Read README.md' });

  assert.deepEqual(kinds(c.entries), ['tool', 'tool_result', 'text', 'result'], 'hook, init and rate limit events say nothing');
  const [tool, toolResult, text, result] = c.entries;
  assert.deepEqual(tool, {
    kind: 'tool',
    id: 'toolu_015DjiMUzfwH3GUYbpF92zzH',
    name: 'Read',
    input: '{"file_path":"/private/WORKTREE/README.md"}',
    summary: '/private/WORKTREE/README.md',
    file: '/private/WORKTREE/README.md',
    at: '2026-11-08T17:42:22.186Z',
  });
  assert.deepEqual(toolResult, {
    kind: 'tool_result',
    id: 'toolu_015DjiMUzfwH3GUYbpF92zzH',
    ok: true,
    output: '1\t# Fixture repo\n2\t\n3\tHello from the fixture repo.\n4\t',
    lines: 4,
    at: '2026-11-08T17:42:22.219Z',
  });
  assert.deepEqual(text, { kind: 'text', text: 'Fixture repo', at: '2026-11-08T17:42:23.227Z' });
  assert.deepEqual(result, { kind: 'result', subtype: 'success', turns: 2, cost: 0.00373356 });

  const end = classifyRun(c.run);
  assert.equal(end.kind, 'finished');
  assert.deepEqual(resultFields(c.run.result, c.run.exitCode, c.run.sessionId), {
    exit_code: 0,
    session_id: ZERO_ID,
    num_turns: 2,
    input_tokens: 4,
    output_tokens: 115,
    cache_read_tokens: 39026,
    cache_write_tokens: 16427,
    cost_usd: 0.00373356,
    result_text: 'Fixture repo',
  });
});

test('max-turns: an error_max_turns result fails the run, and a message split over events is one turn', async () => {
  const c = await replay('max-turns');
  assert.deepEqual(classifyRun(c.run), { kind: 'failed', reason: 'error_max_turns' });
  // The thinking and the tool use are two events of one message.
  assert.deepEqual(c.live, { turns: 1, message: 'msg_011Cgqsdwvb8B8nmfnhmn5P4', tool: 'Read README.md' });
  assert.deepEqual(kinds(c.entries), ['tool', 'tool_result', 'result']);
  assert.deepEqual(c.entries.at(-1), { kind: 'result', subtype: 'error_max_turns', turns: 2, cost: 0.00301273 });
  const fields = resultFields(c.run.result, c.run.exitCode, c.run.sessionId);
  assert.equal(fields.result_text, null, 'an error_max_turns result has no result text');
  assert.equal(fields.num_turns, 2);
});

test('denied-tool: the refused call is a failed tool result, and the denial names the command', async () => {
  const c = await replay('denied-tool');
  const end = classifyRun(c.run);
  assert.equal(end.kind, 'finished', 'a refused tool does not end the run');
  const denials = c.run.result?.permission_denials ?? [];
  assert.equal(denials.length, 1);
  assert.equal(firstDenial(denials), 'touch out.txt');
  assert.deepEqual(kinds(c.entries), ['tool', 'tool_result', 'text', 'result']);
  const refused = c.entries[1];
  assert.equal(refused.kind === 'tool_result' && refused.ok, false);
  assert.match(refused.kind === 'tool_result' ? refused.output : '', /^Permission to use Bash has been denied/);
  assert.deepEqual(c.live, { turns: 2, message: 'msg_011CgqseVqisfDmFSiryhBqF', tool: 'Bash touch out.txt' });
});

test('structured-output: a --json-schema run answers in structured_output, as the planner reads it', async () => {
  const c = await replay('structured-output');
  const end = classifyRun(c.run);
  assert.equal(end.kind, 'finished');
  assert.deepEqual(c.run.result?.structured_output, { word: 'Fixture', lines: 3 });
  assert.equal(c.run.result?.result, '{"word":"Fixture","lines":3}');
  assert.deepEqual(kinds(c.entries), ['tool', 'tool_result', 'tool', 'tool_result', 'result']);
  assert.deepEqual(c.live, { turns: 2, message: 'msg_011CgqsfCgdHLs7vxWNFPMt1', tool: 'StructuredOutput Fixture' });
});

test('cut-off-after-api-retry: a stream that stops without a result fails the run and keeps its session', async () => {
  const c = await replay('cut-off-after-api-retry');
  assert.equal(c.run.result, undefined);
  assert.deepEqual(classifyRun(c.run), { kind: 'failed', reason: 'claude ended without a result' });
  assert.equal(resultFields(c.run.result, c.run.exitCode, c.run.sessionId).session_id, ZERO_ID);
  assert.deepEqual(c.entries, [], 'an api_retry says nothing in the log');
  assert.equal(c.live.turns, 0);
});

// ── gh: the recordings through the parsers ──────────────────────────────────────────────────────────────────────────

const ghFixture = (name: string) => readFileSync(join(FIXTURES, 'gh', name), 'utf8');
const prFixture = (name: string) => parsePrDetails(ghFixture(`${name}.json`));

test('pr-view-open: an open draft with a check in progress', () => {
  const pr = prFixture('pr-view-open');
  assert.equal(pr.state, 'open');
  assert.equal(pr.draft, true);
  assert.equal(pr.mergeable, 'MERGEABLE');
  assert.equal(pr.merge_state, 'UNSTABLE');
  assert.deepEqual([pr.commits, pr.files, pr.additions, pr.deletions], [1, 15, 208, 11]);
  assert.equal(pr.head, 'b3d4e4491b8d77f72da87918024d2d0c3be0a2f5');
  assert.deepEqual(pr.checks, { total: 1, failing: 0, pending: 1 });
  assert.deepEqual(pr.check_list, [
    {
      name: 'check',
      state: 'pending',
      url: 'https://github.com/tomrobdev/agentdeck/actions/runs/42506139061/job/128809077528',
      started_at: '2026-11-08T17:40:38Z',
      completed_at: null, // GitHub's zero time, 0001-01-01
    },
  ]);
  assert.equal(pr.paths.length, 15);
  assert.equal(pr.paths[0], 'app/src/components/panels/RepoEditor.vue');
  assert.deepEqual(pr.labels, ['agentdeck:auto-merge']);
  assert.deepEqual(actionsRun(pr.check_list![0].url), { run: '42506139061', job: '128809077528' });
});

test('pr-view-open-no-files: without files and labels asked for, both are empty', () => {
  const pr = prFixture('pr-view-open-no-files');
  assert.equal(pr.state, 'open');
  assert.equal(pr.files, 15, 'the count still comes from changedFiles');
  assert.deepEqual(pr.paths, []);
  assert.deepEqual(pr.labels, []);
});

test('pr-view-merged: a merged PR whose check passed', () => {
  const pr = prFixture('pr-view-merged');
  assert.equal(pr.state, 'merged');
  assert.equal(pr.draft, false);
  assert.equal(pr.mergeable, 'UNKNOWN');
  assert.deepEqual(pr.checks, { total: 1, failing: 0, pending: 0 });
  assert.equal(pr.check_list![0].state, 'pass');
  assert.equal(pr.check_list![0].completed_at, '2026-11-08T17:33:02Z');
  assert.deepEqual(pr.paths, ['daemon/test/api-routes.test.ts']);
});

test('pr-view-over-100-files: GitHub lists only the first 100 of the changed files', () => {
  const pr = prFixture('pr-view-over-100-files');
  assert.equal(pr.files, 163);
  assert.equal(pr.paths.length, 100);
});

test('run-log-failed: the tail of a failed run log, as the worker hears it', () => {
  const log = ghFixture('run-log-failed.txt');
  const tail = logTail(log);
  assert.ok(Buffer.byteLength(tail) <= LOG_TAIL_BYTES);
  assert.ok(tail.split('\n').length <= 60);
  const last = log.trimEnd().split('\n').at(-1)!;
  assert.ok(tail.endsWith(last), 'the tail ends where the log does');
  assert.match(last, /^check\t[^\t]+\t\d{4}-\d\d-\d\dT/, 'each line is job, step, then a timestamped line');
});

// ── the fakes against the recordings ────────────────────────────────────────────────────────────────────────────────

/**
 * The fields each parser reads, by record: a stream event (`assistant`, `system/init`) or a block inside one
 * (`assistant tool_use`, `user tool_result`, a `permission denial` in the result). `*` stands for any key.
 */
const READ: Record<string, string[]> = {
  // adapters/claude.ts: the session to resume.
  'system/init': ['session_id'],
  // adapters/claude.ts: the usage windows and a rejected request.
  rate_limit_event: [
    'rate_limit_info.status',
    'rate_limit_info.resetsAt',
    'rate_limit_info.unifiedWindows.*.utilization',
    'rate_limit_info.unifiedWindows.*.resetsAt',
  ],
  // translate/log.ts (an entry's time and subagent) and translate/live.ts (a turn per message id).
  assistant: ['message.id', 'message.content', 'parent_tool_use_id', 'timestamp'],
  'assistant text': ['text'],
  'assistant tool_use': ['id', 'name', 'input'],
  user: ['message.content', 'parent_tool_use_id', 'timestamp'],
  'user tool_result': ['tool_use_id', 'content', 'is_error'],
  // classifyRun and resultFields, adapters/claude.ts (api_error_status), the worker (permission_denials), the planner (structured_output).
  result: [
    'subtype',
    'is_error',
    'result',
    'structured_output',
    'session_id',
    'num_turns',
    'total_cost_usd',
    'api_error_status',
    'permission_denials',
    'usage.input_tokens',
    'usage.output_tokens',
    'usage.cache_read_input_tokens',
    'usage.cache_creation_input_tokens',
  ],
  // firstDenial.
  'permission denial': ['tool_name', 'tool_input.command'],
};

interface Rec {
  kind: string;
  value: unknown;
}

/** A stream's events as records: each event, each content block of a message, each denial of a result. */
function records(events: any[]): Rec[] {
  const out: Rec[] = [];
  for (const ev of events) {
    out.push({ kind: ev.type === 'system' ? `system/${ev.subtype}` : String(ev.type), value: ev });
    if (ev.type === 'assistant' || ev.type === 'user') {
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : [])
        out.push({ kind: `${ev.type} ${block?.type}`, value: block });
    }
    if (ev.type === 'result') for (const d of ev.permission_denials ?? []) out.push({ kind: 'permission denial', value: d });
  }
  return out;
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** The values at a dotted path, `*` matching every key. */
function valuesAt(value: unknown, path: string[]): unknown[] {
  if (!path.length) return [value];
  if (!value || typeof value !== 'object') return [];
  const [key, ...rest] = path;
  const obj = value as Record<string, unknown>;
  if (key === '*') return Object.values(obj).flatMap((v) => valuesAt(v, rest));
  return key in obj ? valuesAt(obj[key], rest) : [];
}

/** How a field stands across records: in every one, in none, and the JSON types it has. */
function fieldShape(recs: Rec[], path: string) {
  const per = recs.map((r) => valuesAt(r.value, path.split('.')));
  return { always: per.every((v) => v.length > 0), never: per.every((v) => v.length === 0), types: new Set(per.flat().map(typeOf)) };
}

/** Where `fake`'s records differ from `fixture`'s in the fields the parsers read, one line each, naming the field and the fixture. */
function shapeProblems(fixture: string, fixtureRecs: Rec[], fakeName: string, fakeRecs: Rec[]): string[] {
  const problems: string[] = [];
  for (const [kind, paths] of Object.entries(READ)) {
    const fx = fixtureRecs.filter((r) => r.kind === kind);
    if (!fx.length) continue;
    const fk = fakeRecs.filter((r) => r.kind === kind);
    if (!fk.length) {
      problems.push(`${kind}: ${fixture} has one, ${fakeName} has none`);
      continue;
    }
    for (const path of paths) {
      const want = fieldShape(fx, path);
      const got = fieldShape(fk, path);
      if (want.always && !got.always) problems.push(`${kind} ${path}: every ${kind} in ${fixture} has it, ${fakeName} leaves it out`);
      if (want.never && !got.never) problems.push(`${kind} ${path}: ${fakeName} has it, no ${kind} in ${fixture} does`);
      for (const t of got.types) {
        if (!want.never && !want.types.has(t))
          problems.push(`${kind} ${path}: ${fakeName} gives a ${t}, ${fixture} a ${[...want.types].join(' or ')}`);
      }
    }
  }
  return problems;
}

const fixtureRecords = (name: string): Rec[] =>
  records(
    readFileSync(join(FIXTURES, 'claude', `${name}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );

/** Each recording and the fake run that stands for it. */
const PAIRS: { fixture: string; prompt: string; args?: string[] }[] = [
  { fixture: 'done-with-tool', prompt: 'FAKE_DONE FAKE_TOOLS' },
  { fixture: 'max-turns', prompt: 'FAKE_MAX_TURNS' },
  { fixture: 'denied-tool', prompt: 'FAKE_DENIED' },
  { fixture: 'structured-output', prompt: 'plan the repo', args: ['--json-schema', '{}'] },
  { fixture: 'cut-off-after-api-retry', prompt: 'FAKE_EXIT_MIDSTREAM' },
];

test('every field the parsers read is in a recording, so a field claude renames fails here', () => {
  const all = PAIRS.flatMap((p) => fixtureRecords(p.fixture));
  const missing = Object.entries(READ).flatMap(([kind, paths]) =>
    paths
      .filter(
        (path) =>
          fieldShape(
            all.filter((r) => r.kind === kind),
            path,
          ).never,
      )
      .map((path) => `${kind} ${path}`),
  );
  assert.deepEqual(missing, []);
});

for (const pair of PAIRS) {
  test(`fake-claude "${pair.prompt}" has the shape of ${pair.fixture}.jsonl`, async () => {
    const fake = await fakeRun(pair.prompt, pair.args);
    const problems = shapeProblems(
      `${pair.fixture}.jsonl`,
      fixtureRecords(pair.fixture),
      `the fake's "${pair.prompt}" run`,
      records(fake.events),
    );
    assert.deepEqual(problems, [], `fake-claude.mjs differs from ${pair.fixture}.jsonl:\n${problems.join('\n')}`);
    // And the parsers make of it what they make of the recording: the same end, and at least the same kinds of log entry.
    const real = await replay(pair.fixture);
    assert.equal(classifyRun(fake.run).kind, classifyRun(real.run).kind);
    const fakeKinds = new Set(kinds(fake.entries));
    assert.deepEqual(
      kinds(real.entries).filter((k) => !fakeKinds.has(k)),
      [],
      `log entries ${pair.fixture}.jsonl gives and the fake doesn't`,
    );
  });
}

test('the shape check names the field and the fixture when the fake leaves one out', () => {
  const fixture = fixtureRecords('done-with-tool');
  const fake = fixture.map((r) => {
    if (r.kind !== 'result') return r;
    const { num_turns: _turns, ...rest } = r.value as Record<string, unknown>;
    return { ...r, value: rest };
  });
  assert.deepEqual(shapeProblems('done-with-tool.jsonl', fixture, 'the fake', fake), [
    'result num_turns: every result in done-with-tool.jsonl has it, the fake leaves it out',
  ]);
});

/** Every leaf of a value as `path: type`, arrays' items under `path[]`. */
function leaves(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  const put = (p: string, t: string) => out.set(p, out.has(p) && out.get(p) !== t ? `${out.get(p)}|${t}` : t);
  put(path || '.', typeOf(value));
  if (Array.isArray(value)) for (const item of value) for (const [p, t] of leaves(item, `${path}[]`)) put(p, t);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) for (const [p, t] of leaves(v, path ? `${path}.${k}` : k)) put(p, t);
  }
  return out;
}

test('fakeCodeHost answers prDetails with the shape parsePrDetails gives real gh output', async () => {
  const real = ['pr-view-open', 'pr-view-open-no-files', 'pr-view-merged', 'pr-view-over-100-files'].map((n) => [n, prFixture(n)] as const);
  const fake: PrDetails = await fakeCodeHost().prDetails('https://example.test/pull/1', repo);
  const fakeLeaves = leaves(fake);
  const problems: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const [name, pr] of real) {
    const these = leaves(pr);
    for (const [p, t] of these) for (const one of t.split('|')) seen.set(p, (seen.get(p) ?? new Set()).add(one));
    for (const p of these.keys()) {
      if (!p.includes('[]') && !fakeLeaves.has(p)) problems.push(`${p}: ${name}.json has it, the fake's details leave it out`);
    }
  }
  for (const [p, t] of fakeLeaves) {
    const want = seen.get(p);
    if (!want) problems.push(`${p}: the fake's details have it, no gh fixture does`);
    else
      for (const one of t.split('|'))
        if (!want.has(one)) problems.push(`${p}: the fake's is a ${one}, the gh fixtures' a ${[...want].join(' or ')}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(actionsRun(fake.check_list![0].url), "the fake check's link reads as a GitHub Actions job, as the real ones do");
  assert.equal(typeof (await fakeCodeHost().failedLog(repo, '1')), 'string');
});
