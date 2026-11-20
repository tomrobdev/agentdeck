import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-cli-help-'));

const { COMMANDS } = await import('#cli/commands.ts');
const { HELP } = await import('#cli/help.ts');
const { NOTIFY_KINDS } = await import('#domain/operations/notification.ts');

test('every command is in the help', () => {
  const missing = Object.keys(COMMANDS).filter((name) => !new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(HELP));
  assert.deepEqual(missing, []);
});

test('the help is the saved copy', () => {
  const saved = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'cli', 'help.txt'), 'utf8');
  assert.equal(HELP, saved);
});

test('the help lists every notification kind', () => {
  for (const kind of NOTIFY_KINDS) assert.ok(HELP.includes(kind), kind);
});
