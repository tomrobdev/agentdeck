// The keys' labels and scopes, the `g` and `p` sequences, and the `?` sheet's list (app/src/lib/shared/hotkeys.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GO_KEYS,
  type HotkeyDef,
  PRIORITY_KEYS,
  SEQUENCE_MS,
  keyCaps,
  registerKeys,
  registeredKeys,
  resolveKey,
  sheetGroups,
} from '../../app/src/lib/shared/hotkeys.ts';

const BINDINGS = [...GO_KEYS.map((g) => g.key), ...PRIORITY_KEYS.map((p) => `p ${p.key}`), 'j', 'c', 'e'];

test('g then a key completes a sequence; g alone waits', () => {
  const first = resolveKey(BINDINGS, null, 'g', 1000);
  assert.deepEqual(first, { match: null, pending: { key: 'g', at: 1000 } });
  for (const g of GO_KEYS) assert.equal(resolveKey(BINDINGS, first.pending, g.key.split(' ')[1], 1200).match, g.key);
});

test('p then 1 is a sequence, and 1 alone is nothing', () => {
  const first = resolveKey(BINDINGS, null, 'p', 0);
  assert.equal(resolveKey(BINDINGS, first.pending, '1', 10).match, 'p 1');
  assert.equal(resolveKey(BINDINGS, null, '1', 10).match, null);
});

test('a second key that completes nothing ends the wait and counts as a key of its own', () => {
  const pending = resolveKey(BINDINGS, null, 'g', 0).pending;
  assert.deepEqual(resolveKey(BINDINGS, pending, 'j', 5), { match: 'j', pending: null });
  assert.deepEqual(resolveKey(BINDINGS, pending, 'z', 5), { match: null, pending: null });
});

test('a wait is over after SEQUENCE_MS', () => {
  const pending = resolveKey(BINDINGS, null, 'g', 0).pending;
  assert.equal(resolveKey(BINDINGS, pending, 'q', SEQUENCE_MS).match, 'g q');
  assert.equal(resolveKey(BINDINGS, pending, 'q', SEQUENCE_MS + 1).match, null);
});

test('a single key matches only when bound', () => {
  assert.equal(resolveKey(BINDINGS, null, 'c', 0).match, 'c');
  assert.equal(resolveKey(BINDINGS, null, 'C', 0).match, null);
});

test('the g keys go to the queue, insights, settings and repos', () => {
  assert.deepEqual(
    GO_KEYS.map((g) => [g.key, g.to]),
    [
      ['g q', 'queue'],
      ['g i', 'insights'],
      ['g s', 'settings'],
      ['g r', 'repos'],
    ],
  );
});

test('p digits cover every priority level once, urgent first', () => {
  assert.deepEqual(
    PRIORITY_KEYS.map((p) => p.level),
    ['urgent', 'high', 'medium', 'low', 'none'],
  );
  assert.equal(new Set(PRIORITY_KEYS.map((p) => p.key)).size, PRIORITY_KEYS.length);
});

test('keys are named as the sheet shows them', () => {
  assert.deepEqual(keyCaps('g q'), ['g', 'q']);
  assert.deepEqual(keyCaps('M'), ['⇧M']);
  assert.deepEqual(keyCaps('Escape'), ['Esc']);
  assert.deepEqual(keyCaps(' '), ['Space']);
});

test('every registered key appears on the sheet, and one that unmounted does not', () => {
  const queue: HotkeyDef[] = [
    { key: 'j', label: 'Next task', scope: 'queue' },
    { key: 'p 1', label: 'Set the priority: urgent', scope: 'queue' },
  ];
  const app: HotkeyDef[] = [{ key: 'g q', label: 'Go to the queue', scope: 'app' }];
  const stopQueue = registerKeys(queue);
  const stopApp = registerKeys(app);
  const listed = sheetGroups(registeredKeys()).flatMap((g) => g.keys);
  for (const d of [...queue, ...app])
    assert.ok(
      listed.some((k) => k.key === d.key && k.label === d.label),
      d.key,
    );
  assert.deepEqual(
    sheetGroups(registeredKeys()).map((g) => g.scope),
    ['app', 'queue'],
  );
  stopQueue();
  assert.ok(!registeredKeys().some((d) => d.key === 'j'));
  stopApp();
  assert.deepEqual(registeredKeys(), []);
});

test('a key bound in two components of one scope is listed once', () => {
  const stop = [
    registerKeys([{ key: 'c', label: 'New task', scope: 'queue' }]),
    registerKeys([{ key: 'c', label: 'New task', scope: 'queue' }]),
  ];
  assert.equal(sheetGroups(registeredKeys())[0].keys.length, 1);
  stop.forEach((s) => s());
});
