import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '../../src/domain/shared/id.ts';
import { type AttentionCandidate, type HeadlineFacts, headline } from '../../src/domain/operations/headline.ts';

const NOW = 1_800_000_000;
const facts = (over: Partial<HeadlineFacts> = {}): HeadlineFacts => ({
  paused: false,
  rate_limited_until: null,
  governor: { allow: true, until: null },
  running: 0,
  need_you: { proposed: 0, blocked: 0, review: 0 },
  attention: [],
  ...over,
});

test('idle, or working with a task running', () => {
  assert.equal(headline(facts(), NOW).state, 'idle');
  assert.equal(headline(facts({ running: 1 }), NOW).state, 'working');
});

test('precedence: paused, then rate limited, then hold, then working', () => {
  const all = facts({ paused: true, rate_limited_until: NOW + 60, governor: { allow: false, until: NOW + 120 }, running: 1 });
  assert.deepEqual(headline(all, NOW), { state: 'paused', until: null, need_you: 0, attention: [], review_due: [] });
  assert.deepEqual(headline({ ...all, paused: false }, NOW).state, 'rate_limited');
  assert.equal(headline({ ...all, paused: false }, NOW).until, NOW + 60);
  const hold = headline({ ...all, paused: false, rate_limited_until: null }, NOW);
  assert.equal(hold.state, 'hold');
  assert.equal(hold.until, NOW + 120);
  assert.equal(headline({ ...all, paused: false, rate_limited_until: null, governor: { allow: true, until: null } }, NOW).state, 'working');
});

test('a hold with no known end has no until', () => {
  assert.deepEqual(headline(facts({ governor: { allow: false, until: null } }), NOW).until, null);
});

test('a rate limit that has passed counts as not limited', () => {
  assert.equal(headline(facts({ rate_limited_until: NOW - 1 }), NOW).state, 'idle');
  assert.equal(headline(facts({ rate_limited_until: NOW }), NOW).state, 'idle');
  assert.equal(headline(facts({ rate_limited_until: NOW + 1 }), NOW).state, 'rate_limited');
});

test('need_you adds proposed, blocked and review', () => {
  assert.equal(headline(facts({ need_you: { proposed: 2, blocked: 3, review: 4 } }), NOW).need_you, 9);
});

test('attention: blocked, then review, then proposed, each by priority then id, at most five', () => {
  const c = (id: number, why: AttentionCandidate['why'], priority = 0): AttentionCandidate => ({
    id: asTaskId(id),
    title: `t${id}`,
    why,
    priority,
  });
  const attention = [
    c(1, 'proposed', 90),
    c(2, 'review', 10),
    c(3, 'blocked', 0),
    c(4, 'blocked', 50),
    c(5, 'review', 10),
    c(6, 'proposed'),
    c(7, 'blocked', 0),
  ];
  const got = headline(facts({ attention }), NOW).attention;
  assert.deepEqual(
    got.map((a) => [a.id, a.why]),
    [
      [4, 'blocked'],
      [3, 'blocked'],
      [7, 'blocked'],
      [2, 'review'],
      [5, 'review'],
    ],
  );
  assert.deepEqual(Object.keys(got[0]!), ['id', 'title', 'why']);
});
