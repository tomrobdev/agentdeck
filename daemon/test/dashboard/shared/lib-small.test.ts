// The dashboard's small helpers: stored view settings, fuzzy ranking, chip tones, forms and the wire documents.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestScore, fuzzyScore, rank } from '#app/lib/shared/fuzzy.ts';
import { loadSetting, saveSetting } from '#app/lib/shared/storage.ts';
import { statusTone } from '#app/lib/shared/tone.ts';
import { needsOf, questionOf } from '#app/lib/shared/wire.ts';
import { describeState, describeStaleDaemon } from '#app/lib/operations/daemon-wording.ts';

const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
  },
});

test('a view setting is stored under the agentdeck prefix, merged over an object fallback, and falls back on bad data', () => {
  assert.equal(loadSetting('a', 5), 5);
  saveSetting('a', 7);
  assert.equal(memory.get('agentdeck.a'), '7');
  assert.equal(loadSetting('a', 5), 7);
  saveSetting('o', { x: 1 });
  assert.deepEqual(loadSetting('o', { x: 0, y: 2 }), { x: 1, y: 2 });
  saveSetting('list', [1]);
  assert.deepEqual(loadSetting('list', [9]), [1]);
  memory.set('agentdeck.bad', '{');
  assert.equal(loadSetting('bad', 'fallback'), 'fallback');
});

test('fuzzy: every query letter must appear in order; a start, a word start and a run score higher; an exact match wins', () => {
  assert.equal(fuzzyScore('', 'anything'), 0);
  assert.equal(fuzzyScore('xyz', 'abc'), null);
  assert.ok((fuzzyScore('abc', 'abc') ?? 0) > 1000);
  assert.ok((fuzzyScore('ab', 'abxx') ?? 0) > (fuzzyScore('ab', 'xaxb') ?? 0));
  assert.ok((fuzzyScore('fb', 'foo bar') ?? 0) > (fuzzyScore('fb', 'fxxxxxxbar') ?? 0));
  assert.equal(bestScore('q', ['zzz', 'qq']) !== null, true);
  assert.equal(bestScore('q', ['zzz']), null);
});

test('rank orders items by their best field score then their bonus, keeps the order for an empty query and drops non-matches', () => {
  const items = [{ n: 'alpha' }, { n: 'beta' }, { n: 'alphabet' }];
  assert.deepEqual(
    rank(items, '', (i) => [i.n]).map((i) => i.n),
    ['alpha', 'beta', 'alphabet'],
  );
  assert.deepEqual(
    rank(items, 'alpha', (i) => [i.n]).map((i) => i.n),
    ['alpha', 'alphabet'],
  );
  assert.deepEqual(
    rank(
      items,
      'a',
      (i) => [i.n],
      (i) => (i.n === 'beta' ? 100 : 0),
    ).map((i) => i.n)[0],
    'beta',
  );
});

test('a status has a chip tone, and an unknown one is muted', () => {
  assert.equal(statusTone('running'), 'running');
  assert.equal(statusTone('checks_failed'), 'failed');
  assert.equal(statusTone('mystery'), 'muted');
});

test('the wire documents of a task read back as needs and a question, or null when malformed', () => {
  assert.deepEqual(needsOf('{"kind":"deps","items":["a"]}'), { kind: 'deps', items: ['a'] });
  assert.equal(needsOf('{"kind":"tea"}'), null);
  assert.equal(needsOf(null), null);
  assert.equal(needsOf('{'), null);
  assert.deepEqual(questionOf('{"question":"q","options":[1,"b"]}'), { question: 'q', options: ['1', 'b'] });
  assert.equal(questionOf('{"question":"q"}'), null);
  assert.equal(questionOf(null), null);
});

test('the daemon state is worded as offline, connecting, or by its headline', () => {
  const status = (state: string, until: number | null = null) =>
    ({ headline: { state, until }, governor: { reason: 'budget' }, daemon: null }) as never;
  assert.equal(describeState(null, true).label, 'Daemon offline');
  assert.equal(describeState(null, false).label, 'Connecting…');
  assert.equal(describeState(status('paused'), false).label, 'Paused');
  assert.match(describeState(status('rate_limited', 4_000_000_000), false).label, /^Rate limited · /);
  assert.equal(describeState(status('hold'), false).label, 'On hold');
  assert.match(describeState(status('hold', 4_000_000_000), false).label, /^On hold · until /);
  assert.equal(describeState(status('working'), false).title, 'budget');
  assert.equal(describeState(status('idle'), false).label, 'Idle');
});

test('a stale daemon is named when its commit differs from the dashboard, and not otherwise', () => {
  const status = { daemon: { commit: 'abcdef123456', started_at: '2026-01-01T10:00:00Z' } } as never;
  assert.match(describeStaleDaemon(status, 'fff') ?? '', /older code \(abcdef1, started /);
  assert.equal(describeStaleDaemon(status, 'abcdef123456'), null);
  assert.equal(describeStaleDaemon(status, null), null);
  assert.equal(describeStaleDaemon(null, 'x'), null);
});
