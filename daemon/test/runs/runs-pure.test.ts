// Pure tests of runs: the model, resuming, results, escalation, unblock answers and how a sync is worded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Run,
  conflictReason,
  editsSinceCutOff,
  escalation,
  escalationReason,
  escalationSince,
  firstDenial,
  isEnvironmentBlock,
  pickRun,
  resultFields,
  resumableSession,
  resumeFailed,
  resumeMaxTurns,
  runEndOf,
  runModel,
  setupFailedReason,
  syncSummary,
  unblockDecision,
  unblockable,
  buildUnblockPrompt,
  parseUnblock,
  unblockSystemPrompt,
  withTurnUsage,
} from '#domain/runs/index.ts';
import { asTaskId } from '#domain/shared/index.ts';

const run = (over: Record<string, unknown>) =>
  ({ kind: 'work', attempt: 1, outcome: null, live_turns: 0, num_turns: null, ...over }) as unknown as Run;
const end = (over: Record<string, unknown>) => ({ outcome: 'failed', reason: null, needs: null, denials: 0, turns: 3, ...over }) as never;

test('a work run takes its task model, a review or verify run the review model, a resolve or unblock run the support model', () => {
  const models = { support_model: 'haiku', review_model: 'opus' };
  assert.equal(runModel('work', { model: 'sonnet' }, models), 'sonnet');
  assert.equal(runModel('review', { model: 'sonnet' }, models), 'opus');
  assert.equal(runModel('verify', { model: 'sonnet' }, models), 'opus');
  assert.equal(runModel('resolve', { model: 'sonnet' }, models), 'haiku');
  assert.equal(runModel('unblock', { model: 'sonnet' }, models), 'haiku');
});

test('an interrupted attempt resumes its session, with the turns it has left, unless a later run ended the attempt', () => {
  const cut = run({ outcome: 'interrupted', session_id: 's1', num_turns: 10, ended_at: '2026-01-01 10:00:00' });
  assert.equal(resumableSession({ attempts: 1 }, [cut]), 's1');
  assert.equal(resumableSession({ attempts: 2 }, [cut]), null);
  assert.equal(resumableSession({ attempts: 1 }, [cut, run({ outcome: 'failed' })]), null);
  assert.equal(resumeMaxTurns({ attempts: 1, max_turns: 30 }, [cut]), 20);
  assert.equal(resumeMaxTurns({ attempts: 1, max_turns: 5 }, [cut]), 1);
  assert.equal(resumeMaxTurns({ attempts: 1, max_turns: 30 }, [run({ outcome: 'rate_limited', live_turns: 4 })]), 26);
});

test('edits since the cut-off name the prompt, plan and step fields a person changed after the session ended, once each', () => {
  const cut = run({ outcome: 'interrupted', session_id: 's1', ended_at: '2026-01-01 10:00:00' });
  const own = [
    { type: 'edit', reason: 'prompt, title', at: '2026-01-01 11:00:00' },
    { type: 'edit', reason: 'prompt', at: '2026-01-01 12:00:00' },
    { type: 'edit', reason: 'plan_steps', at: '2026-01-01 09:00:00' },
    { type: 'retry', reason: 'prompt', at: '2026-01-01 12:00:00' },
  ];
  assert.deepEqual(
    editsSinceCutOff({ attempts: 1 }, [cut], { own, planOwner: [{ type: 'edit', reason: 'plan', at: '2026-01-01 13:00:00' }] }),
    ['prompt', 'plan'],
  );
  assert.deepEqual(editsSinceCutOff({ attempts: 1 }, [], { own }), []);
});

test('pickRun picks a run by id, a work run by attempt, or the latest', () => {
  const runs = [run({ id: 1, attempt: 1 }), run({ id: 2, attempt: 1, kind: 'sync' }), run({ id: 3, attempt: 2 })];
  assert.equal(pickRun(runs, { run: 2 })?.id, 2);
  assert.equal(pickRun(runs, { attempt: 1 })?.id, 1);
  assert.equal(pickRun(runs)?.id, 3);
  assert.equal(pickRun([], {}), undefined);
});

test('a run end records whether the last test failed, and null when none ran', () => {
  assert.deepEqual(runEndOf({ end: 'done' as never, last_test: 'failed' as never }), { run_end: 'done', last_test_failed: true });
  assert.deepEqual(runEndOf({ end: 'done' as never, last_test: 'passed' as never }).last_test_failed, false);
  assert.equal(runEndOf({ end: 'done' as never, last_test: null }).last_test_failed, null);
});

test('resultFields reads claude result, falling back to the exit code, the session and zero usage', () => {
  assert.deepEqual(
    resultFields(
      {
        session_id: 'x',
        num_turns: 4,
        total_cost_usd: 0.5,
        result: 'ok',
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      },
      0,
    ),
    {
      exit_code: 0,
      session_id: 'x',
      num_turns: 4,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      cost_usd: 0.5,
      result_text: 'ok',
    },
  );
  const none = resultFields(undefined, 1, 'fallback');
  assert.deepEqual(
    [none.exit_code, none.session_id, none.num_turns, none.input_tokens, none.cost_usd, none.result_text],
    [1, 'fallback', null, 0, 0, null],
  );
});

test('withTurnUsage adds a turn tokens, cost and turns to the totals, keeping null turns when neither has any', () => {
  const sum = withTurnUsage(
    { input_tokens: 1, cost_usd: 1, num_turns: 2 },
    { input_tokens: 2, output_tokens: 5, cost_usd: 0.5, num_turns: 3 },
  );
  assert.deepEqual([sum.input_tokens, sum.output_tokens, sum.cost_usd, sum.num_turns], [3, 5, 1.5, 5]);
  assert.equal(withTurnUsage({}, {}).num_turns, null);
  assert.equal(withTurnUsage({ num_turns: 1 }, {}).num_turns, 1);
});

test('a resume failed only when claude found no conversation, not when cancelled, rate limited or finished fine', () => {
  const base = {
    result: undefined,
    exitCode: 1,
    rateLimitedUntil: undefined,
    cancelled: false,
    stderr: 'No conversation found with session ID x',
  };
  assert.ok(resumeFailed(base));
  assert.ok(!resumeFailed({ ...base, cancelled: true }));
  assert.ok(!resumeFailed({ ...base, rateLimitedUntil: 5 }));
  assert.ok(!resumeFailed({ ...base, result: { is_error: false } }));
  assert.ok(!resumeFailed({ ...base, stderr: 'other' }));
  assert.ok(resumeFailed({ ...base, stderr: '', result: { is_error: true, result: 'no conversation found' } }));
});

test('a block caused by the environment is one with needs, a tool denial or a setup failure', () => {
  assert.ok(isEnvironmentBlock({ needs: { kind: 'deps', items: ['x'] } }));
  assert.ok(isEnvironmentBlock({ denials: 1 }));
  assert.ok(isEnvironmentBlock({ setupFailed: true }));
  assert.ok(!isEnvironmentBlock({}));
  assert.equal(setupFailedReason('a\nboom\n'), 'setup failed: boom');
});

test('firstDenial names the first refused command on one line, or the tool, or unknown tool', () => {
  assert.equal(firstDenial([{ tool_name: 'Bash', tool_input: { command: 'git  push\n--force' } }]), 'git push --force');
  assert.equal(firstDenial([{ tool_name: 'Edit', tool_input: {} }]), 'Edit');
  assert.equal(firstDenial([]), 'unknown tool');
  assert.equal(firstDenial([{ tool_input: { command: 'x'.repeat(300) } }]).length, 200);
});

test('a failure escalates one model up only when the repo allows it, the run used the task model, and the failure is one a stronger model may fix', () => {
  const task = { model: 'haiku' };
  const repo = { escalate: true };
  assert.deepEqual(escalation(task, { model: 'haiku' }, end({ reason: 'error_max_turns' }), repo), {
    from: 'haiku',
    to: 'sonnet',
    cause: 'turn_limit',
  });
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'tests failed' }), repo)?.cause, 'tests_failed');
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'error_during_execution' }), repo)?.cause, 'error');
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'claude ended without a result' }), repo)?.cause, 'no_result');
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'claude ended without a result', turns: 0 }), repo), null);
  assert.equal(
    escalation(task, { model: 'haiku' }, end({ outcome: 'blocked', reason: 'agent finished without changing anything' }), repo)?.cause,
    'no_change',
  );
  assert.equal(escalation(task, { model: 'haiku' }, end({ outcome: 'blocked', reason: 'other' }), repo), null);
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'error_max_turns' }), { escalate: false }), null);
  assert.equal(escalation(task, { model: 'sonnet' }, end({ reason: 'error_max_turns' }), repo), null);
  assert.equal(escalation({ model: 'opus' }, { model: 'opus' }, end({ reason: 'error_max_turns' }), repo), null);
  assert.equal(escalation(task, { model: 'haiku' }, end({ outcome: 'done' }), repo), null);
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'error_max_turns', denials: 2 }), repo), null);
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'error_max_turns', needs: { kind: 'deps', items: ['x'] } }), repo), null);
  assert.equal(escalation(task, { model: 'haiku' }, end({ reason: 'setup failed: x' }), repo), null);
  assert.equal(
    escalation({ model: 'claude-sonnet-4-5' }, { model: 'claude-sonnet-4-5' }, end({ reason: 'error_max_turns' }), repo)?.to,
    'opus',
  );
});

test('the escalation reason says the new model, the old one and the cause, with the last run verdict if any', () => {
  const e = { from: 'haiku', to: 'sonnet', cause: 'turn_limit' as const };
  assert.equal(escalationReason(e, null), 'runs on sonnet, up from haiku, after the turn limit');
  assert.equal(
    escalationReason({ ...e, cause: 'no_change' }, 'blocked'),
    'runs on sonnet, up from haiku, after a run that changed nothing (the last run blocked)',
  );
});

test('escalationSince is the latest escalation reason since the last real work run, ignoring interrupted and rate-limited ones', () => {
  const events = [
    { type: 'escalate', reason: 'old', at: '2026-01-01 08:00:00' },
    { type: 'escalate', reason: 'new', at: '2026-01-01 11:00:00' },
  ];
  const runs = [
    { kind: 'work' as const, outcome: 'failed' as const, started_at: '2026-01-01 10:00:00' },
    { kind: 'work' as const, outcome: 'interrupted' as const, started_at: '2026-01-01 12:00:00' },
  ];
  assert.equal(escalationSince(events, runs), 'new');
  assert.equal(escalationSince(events.slice(0, 1), runs), null);
  assert.equal(escalationSince(events, []), null);
});

const blocked = { status: 'blocked' as const, stop_reason: 'unclear', needs: null, question: null };

test('an unblock run starts only in a repo with auto_unblock, for a blocked task a person need not settle, once since the last work run', () => {
  const repo = { auto_unblock: true };
  assert.ok(unblockable(blocked, [], repo));
  assert.ok(!unblockable(blocked, [], { auto_unblock: false }));
  assert.ok(!unblockable({ status: 'queued' }, [], repo));
  assert.ok(!unblockable({ ...blocked, needs: { kind: 'deps', items: ['x'] } }, [], repo));
  assert.ok(unblockable({ ...blocked, needs: { kind: 'edit', items: ['x'] } }, [], repo));
  assert.ok(!unblockable({ ...blocked, stop_reason: 'setup failed: x' }, [], repo));
  assert.ok(!unblockable({ ...blocked, stop_reason: 'conflicts with main in 2 files: a, b' }, [], repo));
  assert.ok(
    !unblockable(
      blocked,
      [
        { kind: 'work', outcome: 'blocked' },
        { kind: 'unblock', outcome: 'done' },
      ],
      repo,
    ),
  );
  assert.ok(
    unblockable(
      blocked,
      [
        { kind: 'unblock', outcome: 'done' },
        { kind: 'work', outcome: 'blocked' },
      ],
      repo,
    ),
  );
  assert.ok(
    unblockable(
      blocked,
      [
        { kind: 'work', outcome: 'blocked' },
        { kind: 'unblock', outcome: 'rate_limited' },
      ],
      repo,
    ),
  );
});

test('the unblock prompt gives the reason, the worker message, review notes, the task and the plan steps it follows, and asks for an UNBLOCK line', () => {
  const task = { id: asTaskId(9), title: 'Do it', prompt: 'Goal text', stop_reason: 'stuck here' };
  const bare = buildUnblockPrompt(task, { plan: null, lastMessage: null, reviewNote: null });
  assert.match(bare, /unblock run for task #9: "Do it"/);
  assert.match(bare, /stuck here/);
  assert.match(bare, /UNBLOCK: RETRY:/);
  assert.ok(!bare.includes('final message:\n'));
  const html =
    '<html data-agentdeck-plan="1"><body><section data-plan-step id="a"><h2>First</h2>do a</section><section data-plan-step id="b"><h2>Second</h2></section></body></html>';
  const full = buildUnblockPrompt(
    { ...task, stop_reason: null },
    { plan: { name: '1-x.html', html, steps: ['a'] } as never, lastMessage: 'I stopped', reviewNote: 'fix it' },
  );
  assert.match(full, /\(no reason given\)/);
  assert.match(full, /I stopped/);
  assert.match(full, /Notes from review:\nfix it/);
  assert.match(full, /Step "a": First/);
  assert.ok(!full.includes('Second'));
  assert.match(
    buildUnblockPrompt(task, { plan: { name: 'p.html', html: null, steps: null } as never, lastMessage: null, reviewNote: null }),
    /plan p\.html, which could not be read/,
  );
  assert.match(unblockSystemPrompt(), /unblock run/);
});

test('parseUnblock reads the last UNBLOCK line: a retry note, or a question with up to four options; no answer asks with the last line', () => {
  assert.deepEqual(parseUnblock('work\nUNBLOCK: RETRY: use the other file'), { retry: 'use the other file' });
  assert.deepEqual(parseUnblock('UNBLOCK: ASK: which one?\n- a\n* b\n- c\n- d\n- e'), { ask: 'which one?', options: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(parseUnblock('UNBLOCK: ASK: which?\n- a\n\nnot an option\n- b'), { ask: 'which?', options: ['a'] });
  assert.deepEqual(parseUnblock('UNBLOCK: RETRY:\nthe end'), { ask: 'the end', options: [] });
  assert.deepEqual(parseUnblock(null), { ask: 'no output', options: [] });
});

test('an unblock decision retries with a noted retry while attempts are left, else asks a person to retry it', () => {
  assert.deepEqual(unblockDecision({ retry: 'x' }, { attempts: 1, max_attempts: 3 }), { retry: 'Unblock run: x' });
  assert.deepEqual(unblockDecision({ retry: 'x' }, { attempts: 3, max_attempts: 3 }), {
    ask: { question: 'The task has no attempts left. Retry it with this note? x', options: [] },
  });
  assert.deepEqual(unblockDecision({ ask: 'q', options: ['a'] }, { attempts: 1, max_attempts: 3 }), {
    ask: { question: 'q', options: ['a'] },
  });
});

test('a sync summary says clean or how many files were resolved; a conflict reason lists five files and counts the rest', () => {
  assert.equal(syncSummary('main', 'clean', []), 'Synced with main: clean');
  assert.equal(syncSummary('main', 'resolved', ['a']), 'Resolved conflicts in 1 file');
  assert.equal(syncSummary('main', 'resolved', ['a', 'b']), 'Resolved conflicts in 2 files');
  assert.equal(conflictReason('main', ['a', 'b']), 'conflicts with main in 2 files: a, b');
  assert.equal(conflictReason('main', ['1', '2', '3', '4', '5', '6', '7']), 'conflicts with main in 7 files: 1, 2, 3, 4, 5 and 2 more');
  assert.equal(conflictReason('main', []), 'could not sync with main');
  assert.equal(conflictReason('main', ['a'], 'tests failed'), 'conflicts with main in 1 file: a (tests failed)');
});
