// Who shows desktop notifications: the desktop app while it runs, osascript otherwise.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Notification } from '../src/domain/operations/notification.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-notifications-'));
delete process.env.AGENTDECK_NO_NOTIFY;

const { appDelivers } = await import('../src/domain/operations/notification.ts');
const { notify } = await import('../src/application/operations/notifications.ts');
const { appSeen } = await import('../src/application/actions.ts');
const { openDb } = await import('./open-db.ts');

const NOW = 1_793_707_200_000;

test('the app delivers desktop notifications when it was seen in the last 90 s', () => {
  assert.equal(appDelivers(NOW, NOW), true);
  assert.equal(appDelivers(NOW - 89_000, NOW), true);
  assert.equal(appDelivers(NOW - 91_000, NOW), false);
  assert.equal(appDelivers(null, NOW), false);
});

/** Channels that only count what they were asked to send. */
function channels() {
  const sent = { desktop: [] as string[], ntfy: [] as string[] };
  return {
    sent,
    channels: {
      desktop: async (n: Notification) => void sent.desktop.push(n.title),
      ntfy: async (_s: unknown, n: Notification) => void sent.ntfy.push(n.title),
    },
  };
}

const testNote: Notification = { kind: 'test', title: 'Test notification', body: 'hello' };

test('notify() uses osascript when the app has not been seen', async () => {
  const db = openDb(':memory:');
  const { sent, channels: c } = channels();
  await notify(db, testNote, c);
  assert.deepEqual(sent.desktop, ['Test notification']);
  assert.equal(db.recentNotifications(5).length, 1);
});

test('notify() skips osascript while the app delivers, and still records the notification and sends ntfy', async () => {
  const db = openDb(':memory:');
  db.setSetting('ntfy_topic', 'agentdeck-test');
  assert.deepEqual(appSeen(db), { desktop: true });
  const { sent, channels: c } = channels();
  await notify(db, testNote, c);
  assert.deepEqual(sent.desktop, []);
  assert.deepEqual(sent.ntfy, ['Test notification']);
  assert.deepEqual(
    db.recentNotifications(5).map((r) => r.title),
    ['Test notification'],
  );
});

test('notify() goes back to osascript once the app has not been seen for 90 s', async () => {
  const db = openDb(':memory:');
  appSeen(db, Date.now() - 91_000);
  const { sent, channels: c } = channels();
  await notify(db, testNote, c);
  assert.deepEqual(sent.desktop, ['Test notification']);
});

test('the app is told whether desktop notifications are on', () => {
  const db = openDb(':memory:');
  db.setSetting('notify_desktop', '0');
  assert.deepEqual(appSeen(db), { desktop: false });
  assert.ok(db.appSeenAt());
});
