// domain/files: path checks, size limits and git -z output parsing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BINARY_SNIFF,
  capText,
  checkPath,
  isBinary,
  mergeChanges,
  parseLog,
  parseLsTree,
  parseNameStatus,
  parseNumstat,
  treeEntries,
} from '../src/domain/work/read/files.ts';

test('checkPath accepts repo-relative paths and drops trailing slashes', () => {
  assert.deepEqual(checkPath('a.txt'), { ok: true, path: 'a.txt' });
  assert.deepEqual(checkPath('src/a b/c.ts'), { ok: true, path: 'src/a b/c.ts' });
  assert.deepEqual(checkPath('src/'), { ok: true, path: 'src' });
  assert.deepEqual(checkPath('a/-b'), { ok: true, path: 'a/-b' });
  assert.deepEqual(checkPath('..a/b..'), { ok: true, path: '..a/b..' });
});

test('checkPath refuses absolute, .., NUL, option-like and empty paths', () => {
  for (const p of [
    '/etc/passwd',
    '../x',
    'a/../../x',
    'a/..',
    '..',
    'a\0b',
    '-x',
    '--output=/tmp/x',
    '',
    null,
    undefined,
    'a//b',
    './a',
    'a/./b',
  ]) {
    assert.equal(checkPath(p as string).ok, false, JSON.stringify(p));
  }
});

test('checkPath allows the root only when asked', () => {
  assert.deepEqual(checkPath('', { allowRoot: true }), { ok: true, path: '' });
  assert.deepEqual(checkPath(null, { allowRoot: true }), { ok: true, path: '' });
  assert.equal(checkPath('/', { allowRoot: true }).ok, false);
  assert.equal(checkPath('../', { allowRoot: true }).ok, false);
});

test('isBinary looks for a NUL byte in the first 8000 bytes', () => {
  assert.equal(isBinary(new TextEncoder().encode('hello\n')), false);
  assert.equal(isBinary(new Uint8Array([104, 0, 105])), true);
  const late = new Uint8Array(BINARY_SNIFF + 10).fill(97);
  late[BINARY_SNIFF + 1] = 0;
  assert.equal(isBinary(late), false);
  late[BINARY_SNIFF - 1] = 0;
  assert.equal(isBinary(late), true);
});

test('capText keeps text under the limit and cuts on a character or line boundary', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assert.deepEqual(capText(enc('abc'), 3), { text: 'abc', truncated: false });
  assert.deepEqual(capText(enc('abcdef'), 4), { text: 'abcd', truncated: true });
  // é is two bytes; a cut between them backs up to before it.
  assert.deepEqual(capText(enc('abé'), 3), { text: 'ab', truncated: true });
  assert.deepEqual(capText(enc('one\ntwo\nthree'), 10, { wholeLines: true }), { text: 'one\ntwo\n', truncated: true });
  assert.deepEqual(capText(enc('onelongline'), 5, { wholeLines: true }), { text: 'onelo', truncated: true });
});

test('parseNumstat reads counts, binary files and renames', () => {
  const z = '3\t1\ta.txt\0-\t-\tbin.dat\0' + '0\t0\t\0old name.txt\0new\tname.txt\0' + '5\t0\tadded.txt\0';
  assert.deepEqual(parseNumstat(z), [
    { path: 'a.txt', old_path: null, additions: 3, deletions: 1, binary: false },
    { path: 'bin.dat', old_path: null, additions: 0, deletions: 0, binary: true },
    { path: 'new\tname.txt', old_path: 'old name.txt', additions: 0, deletions: 0, binary: false },
    { path: 'added.txt', old_path: null, additions: 5, deletions: 0, binary: false },
  ]);
  assert.deepEqual(parseNumstat(''), []);
});

test('parseNameStatus reads statuses, renames and type changes', () => {
  const z = 'M\0a.txt\0A\0added.txt\0D\0gone.txt\0R087\0old.txt\0new.txt\0T\0link\0';
  assert.deepEqual(parseNameStatus(z), [
    { status: 'M', path: 'a.txt', old_path: null },
    { status: 'A', path: 'added.txt', old_path: null },
    { status: 'D', path: 'gone.txt', old_path: null },
    { status: 'R', path: 'new.txt', old_path: 'old.txt' },
    { status: 'M', path: 'link', old_path: null },
  ]);
});

test('mergeChanges joins status and counts by path', () => {
  const files = mergeChanges(
    'R100\0old.txt\0new.txt\0A\0bin.dat\0M\0a.txt\0',
    '0\t0\t\0old.txt\0new.txt\0-\t-\tbin.dat\0' + '2\t1\ta.txt\0',
  );
  assert.deepEqual(files, [
    { path: 'new.txt', old_path: 'old.txt', status: 'R', additions: 0, deletions: 0, binary: false },
    { path: 'bin.dat', old_path: null, status: 'A', additions: 0, deletions: 0, binary: true },
    { path: 'a.txt', old_path: null, status: 'M', additions: 2, deletions: 1, binary: false },
  ]);
});

test('parseLog splits commits on record and unit separators, with times in UTC like the rest of the API', () => {
  const out = 'abc\x1fFix: a | b\x1fAda\x1f2026-10-19T10:00:00+02:00\x1e\ndef\x1fFirst\x1fBo\x1f2026-10-18T09:00:00Z\x1e\n';
  assert.deepEqual(parseLog(out), [
    { sha: 'abc', subject: 'Fix: a | b', author: 'Ada', at: '2026-10-19 08:00:00' },
    { sha: 'def', subject: 'First', author: 'Bo', at: '2026-10-18 09:00:00' },
  ]);
  assert.deepEqual(parseLog(''), []);
});

test('parseLsTree and treeEntries: folders first, then by name, sizes for files only', () => {
  const z =
    '100644 blob aaa      12\tsrc/z.ts\0' +
    '040000 tree bbb       -\tsrc/lib\0' +
    '100644 blob ccc       0\tsrc/a b.ts\0' +
    '160000 commit ddd       -\tsrc/vendor\0' +
    '040000 tree eee       -\tsrc/app\0';
  assert.equal(parseLsTree(z).length, 4, 'submodule left out');
  assert.deepEqual(treeEntries(z), [
    { name: 'app', path: 'src/app', type: 'dir', size: null },
    { name: 'lib', path: 'src/lib', type: 'dir', size: null },
    { name: 'a b.ts', path: 'src/a b.ts', type: 'file', size: 0 },
    { name: 'z.ts', path: 'src/z.ts', type: 'file', size: 12 },
  ]);
});
