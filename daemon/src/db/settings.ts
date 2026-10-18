// Key-value settings: pause flag, budget, concurrency, notification and planner options.
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULTS } from '../config.ts';
import { BUDGET_KEYS, type Budget, DEFAULT_BUDGET } from '../domain/usage/governor.ts';

export function settingsStore(db: DatabaseSync) {
  return {
    getSetting(key: string, fallback: string): string {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? fallback;
    },
    setSetting(key: string, value: string): void {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    isPaused(): boolean {
      // The daemon starts paused until someone explicitly resumes it.
      return this.getSetting('paused', '1') === '1';
    },
    budget(): Budget {
      return Object.fromEntries(BUDGET_KEYS.map((k) => [k, Number(this.getSetting(k, String(DEFAULT_BUDGET[k])))])) as unknown as Budget;
    },
    maxConcurrent(): number {
      return Number(this.getSetting('max_concurrent', String(DEFAULTS.maxConcurrent)));
    },
  };
}
