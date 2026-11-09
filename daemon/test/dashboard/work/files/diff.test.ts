import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorKey, anchorOf, parsePatch, splitRows } from '../../../../../app/src/lib/work/files/diff.ts';

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -3,4 +3,4 @@ fn',
  ' keep',
  '-old one',
  '-old two',
  '+new one',
  ' ',
  '\\ No newline at end of file',
  '@@ -20 +20,2 @@',
  ' tail',
  '+added',
  '',
].join('\n');

test('parsePatch numbers lines per hunk and skips file headers and the no-newline marker', () => {
  const hunks = parsePatch(PATCH);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].header, '@@ -3,4 +3,4 @@ fn');
  assert.deepEqual(
    hunks[0].lines.map((l) => [l.type, l.old, l.new, l.text]),
    [
      ['ctx', 3, 3, 'keep'],
      ['del', 4, null, 'old one'],
      ['del', 5, null, 'old two'],
      ['add', null, 4, 'new one'],
      ['ctx', 6, 5, ''],
    ],
  );
  assert.deepEqual(
    hunks[1].lines.map((l) => [l.type, l.old, l.new]),
    [
      ['ctx', 20, 20],
      ['add', null, 21],
    ],
  );
});

test('parsePatch of nothing has no hunks', () => {
  assert.deepEqual(parsePatch(''), []);
  assert.deepEqual(parsePatch('diff --git a/x b/x\nBinary files differ\n'), []);
});

test('splitRows pairs each run of deletions with the additions after it', () => {
  const [hunk] = parsePatch(PATCH);
  const rows = splitRows(hunk.lines);
  assert.deepEqual(
    rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]),
    [
      ['keep', 'keep'],
      ['old one', 'new one'],
      ['old two', null],
      ['', ''],
    ],
  );
});

test('splitRows leaves the left blank for additions alone', () => {
  const [, hunk] = parsePatch(PATCH);
  const rows = splitRows(hunk.lines);
  assert.equal(rows[1].left, null);
  assert.equal(rows[1].right?.text, 'added');
});

test('anchorOf puts deleted lines on the old file and the rest on the new one', () => {
  const [hunk] = parsePatch(PATCH);
  const [ctx, del, , add] = hunk.lines;
  assert.deepEqual(anchorOf(del), { side: 'old', line: 4 });
  assert.deepEqual(anchorOf(add), { side: 'new', line: 4 });
  assert.deepEqual(anchorOf(ctx), { side: 'new', line: 3 });
  assert.equal(anchorKey(anchorOf(del)), 'old:4');
});
