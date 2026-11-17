// A freshly migrated scratch database and drizzle-kit run against it, shared by db:check and db:generate.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '#db/index.ts';

export function drizzleKitOnScratch(args: string[]): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-db-'));
  const path = join(dir, 'scratch.db');
  try {
    openDb(path).close();
    const kit = spawnSync('npx', ['drizzle-kit', ...args], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, DRIZZLE_DB: path },
      encoding: 'utf8',
    });
    return { status: kit.status, out: `${kit.stdout}${kit.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
