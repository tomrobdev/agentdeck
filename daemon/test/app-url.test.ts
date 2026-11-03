// parseAppUrl: where an agentdeck:// link goes. The dashboard has no test runner, so its pure helpers are tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// router.ts reads the page's hash when it loads; give it a bare one.
Object.assign(globalThis, { location: { hash: '' }, window: { addEventListener() {} } });
const { hashFor, parseAppUrl, parseHash, taskUrl } = await import('../../app/src/router.ts');

test('#/tray is the tray window, and round-trips', () => {
  assert.deepEqual(parseHash('#/tray'), { name: 'tray' });
  assert.equal(hashFor({ name: 'tray' }), '#/tray');
  // Not a link from outside: an agentdeck:// URL never opens the tray view in the main window.
  assert.equal(parseAppUrl('agentdeck://tray'), null);
});

test('a task link opens that task, on the overview unless a tab is named', () => {
  assert.deepEqual(parseAppUrl('agentdeck://tasks/181'), { name: 'task', id: 181, tab: 'overview', query: {} });
  assert.deepEqual(parseAppUrl('agentdeck://tasks/181/changes'), { name: 'task', id: 181, tab: 'changes', query: {} });
  assert.deepEqual(parseAppUrl('agentdeck://tasks/7/'), { name: 'task', id: 7, tab: 'overview', query: {} });
});

test('new opens the form, and an empty link or queue opens the queue', () => {
  assert.deepEqual(parseAppUrl('agentdeck://new'), { name: 'new' });
  assert.deepEqual(parseAppUrl('agentdeck://'), { name: 'queue' });
  assert.deepEqual(parseAppUrl('agentdeck://queue'), { name: 'queue' });
});

test('anything else is ignored', () => {
  for (const url of [
    'https://tasks/181',
    'agentdeck:tasks/181',
    'agentdeck://tasks/abc',
    'agentdeck://tasks/',
    'agentdeck://tasks/181/nope',
    'agentdeck://tasks/181/changes/extra',
    'agentdeck://settings',
    'agentdeck://new/extra',
    '',
  ]) {
    assert.equal(parseAppUrl(url), null, url);
  }
});

test('taskUrl round-trips through parseAppUrl', () => {
  assert.deepEqual(parseAppUrl(taskUrl(42)), { name: 'task', id: 42, tab: 'overview', query: {} });
});
