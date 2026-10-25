// pnpm db:check: src/db/tables.ts must match the schema the migrations build. Migrates a scratch database, then
// asks drizzle-kit what it would change to make that database match tables.ts; anything but "no changes" fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'agentdeck-db-check-'));
const path = join(dir, 'check.db');
try {
  openDb(path).close();
  const kit = spawnSync('npx', ['drizzle-kit', 'push', '--explain'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, DRIZZLE_DB: path },
    encoding: 'utf8',
  });
  const out = `${kit.stdout}${kit.stderr}`;
  if (kit.status === 0 && /No changes detected/.test(out)) {
    console.log('db:check: src/db/tables.ts matches the migrated schema');
  } else {
    console.error(`db:check: src/db/tables.ts and the migrations disagree:\n${out}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
