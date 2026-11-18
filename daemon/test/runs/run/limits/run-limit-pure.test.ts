import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ClaudeRun,
  advanceClock,
  classifyRun,
  heardLine,
  limitReached,
  limitReason,
  resolveOutcome,
  runOutcome,
  startClock,
} from '#domain/runs/index.ts';

const limits = { stallMs: 15 * 60_000, maxMs: 60 * 60_000, checkMs: 2_000 };
const HOUR = 60 * 60_000;

const ticks = (from: number, count: number, every = limits.checkMs, lines = false) => {
  let clock = startClock(from);
  for (let i = 1; i <= count; i++) {
    const now = from + i * every;
    clock = lines ? heardLine(clock, now, limits) : advanceClock(clock, now, limits);
  }
  return clock;
};

test('the stall limit is reached after enough quiet checks, and a line starts the quiet time again', () => {
  const quiet = ticks(0, limits.stallMs / limits.checkMs);
  assert.deepEqual(limitReached(quiet, limits), { limit: 'stall', ms: limits.stallMs });
  assert.equal(limitReached(ticks(0, limits.stallMs / limits.checkMs - 1), limits), null);
  const heard = heardLine(quiet, quiet.at + 1, limits);
  assert.equal(heard.quietMs, 0);
  assert.equal(limitReached(heard, limits), null);
});

test('the total limit is reached by a run that keeps printing', () => {
  const chatty = ticks(0, limits.maxMs / limits.checkMs, limits.checkMs, true);
  assert.equal(chatty.quietMs, 0);
  assert.deepEqual(limitReached(chatty, limits), { limit: 'total', ms: limits.maxMs });
});

test('a jump of hours between two checks (the Mac slept) counts only a few check intervals', () => {
  const before = ticks(0, 10);
  const woke = advanceClock(before, before.at + 8 * HOUR, limits);
  assert.equal(woke.quietMs - before.quietMs, 3 * limits.checkMs);
  assert.equal(limitReached(woke, limits), null);
  assert.equal(limitReached(heardLine(before, before.at + 8 * HOUR, limits), limits), null);
  assert.equal(advanceClock(woke, woke.at - HOUR, limits).totalMs, woke.totalMs, 'a clock set back counts nothing');
});

test('limitReason names the limit and its length', () => {
  assert.equal(limitReason({ limit: 'stall', ms: 15 * 60_000 }), 'stall limit: claude printed nothing for 15 min');
  assert.equal(limitReason({ limit: 'total', ms: 60 * 60_000 }), 'total limit: claude ran for 60 min');
  assert.equal(limitReason({ limit: 'stall', ms: 1_500 }), 'stall limit: claude printed nothing for 1500 ms');
  assert.equal(limitReason({ limit: 'total', ms: 3_000 }), 'total limit: claude ran for 3 s');
  assert.equal(limitReason({ limit: 'total', ms: 90_000 }), 'total limit: claude ran for 90 s');
  assert.equal(limitReason({ limit: 'stall', ms: 500 }), 'stall limit: claude printed nothing for 500 ms');
});

const killed: ClaudeRun = {
  result: undefined,
  exitCode: -1,
  rateLimitedUntil: undefined,
  cancelled: false,
  stderr: '',
  sessionId: 's1',
  timedOut: { limit: 'stall', ms: 15 * 60_000 },
};

test('classifyRun: a run a limit stopped is timed_out, naming the limit; a cancel still wins', () => {
  assert.deepEqual(classifyRun(killed), {
    kind: 'timed_out',
    stop: { limit: 'stall', ms: 15 * 60_000 },
    reason: 'stall limit: claude printed nothing for 15 min',
  });
  assert.equal(classifyRun({ ...killed, rateLimitedUntil: 2_000_000_000 }).kind, 'timed_out');
  assert.deepEqual(classifyRun({ ...killed, cancelled: true }), { kind: 'cancelled' });
});

test('a timed-out work run ends failed with the limit as its stop reason, and a resolve run fails too', () => {
  const end = classifyRun({ ...killed, timedOut: { limit: 'total', ms: 60 * 60_000 } });
  const came = runOutcome({ end, testsPassed: null, commitsAhead: null, denials: 0 });
  assert.deepEqual(came, { result: { outcome: 'failed', reason: 'total limit: claude ran for 60 min' }, pause: false });
  assert.deepEqual(resolveOutcome(end), { outcome: 'failed', reason: 'total limit: claude ran for 60 min' });
});
