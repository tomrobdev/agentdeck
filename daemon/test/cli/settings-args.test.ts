import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-settings-'));

const { ActionError, updateSettings } = await import('../../src/application/actions.ts');
const { repoSettingPatch, settingPatch } = await import('../../src/cli/settings-args.ts');
const { openDb } = await import('../fixtures/open-db.ts');

test('boolean settings refuse words other than on/off and their synonyms', () => {
  assert.throws(() => settingPatch('planner_enabled', 'yse'), /planner_enabled takes .*"yse"/);
  assert.throws(
    () => repoSettingPatch('auto_merge', 'maybe'),
    (e) => e instanceof ActionError && /on, .*off/.test(e.message),
  );
  assert.deepEqual(settingPatch('planner_enabled', 'Yes'), { planner: { enabled: true } });
  assert.deepEqual(settingPatch('reload_on_change', 'off'), { reload_on_change: false });
});

test('notify_events entries are trimmed', () => {
  assert.deepEqual(settingPatch('notify_events', 'done, failed'), { notify: { events: ['done', 'failed'] } });
  const db = openDb(':memory:');
  const st = updateSettings(db, { notify: { events: [' done ', 'failed'] as never } });
  assert.deepEqual(st.notify.events, ['done', 'failed']);
});

test('planner max_tasks must be a whole number', () => {
  const db = openDb(':memory:');
  assert.throws(() => updateSettings(db, { planner: { max_tasks: 2.5 } }), ActionError);
  assert.equal(updateSettings(db, { planner: { max_tasks: 3 } }).planner.max_tasks, 3);
});

test('the ntfy server, planner interval and planner model are checked before they are stored', () => {
  const db = openDb(':memory:');
  assert.throws(() => updateSettings(db, { notify: { ntfy_server: 'ntfy.sh' } }), /http\(s\) URL/);
  assert.throws(() => updateSettings(db, { planner: { interval_hours: 0.1 } }), /between 0\.25 and 168/);
  assert.throws(() => updateSettings(db, { planner: { model: 'gpt-9' } }), /planner model must be/);
  const st = updateSettings(db, {
    notify: { ntfy_server: 'https://ntfy.example.com' },
    planner: { interval_hours: 2, model: 'sonnet' },
  });
  assert.equal(st.notify.ntfy_server, 'https://ntfy.example.com');
  assert.deepEqual([st.planner.interval_hours, st.planner.model], [2, 'sonnet']);
});

test('the repo set usage lists the PR modes and merge methods', () => {
  assert.throws(
    () => repoSettingPatch('nope', ''),
    (e) =>
      e instanceof ActionError && e.message.includes('pr_mode off|draft|ready') && e.message.includes('merge_method squash|merge|rebase'),
  );
});
