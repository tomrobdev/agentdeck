// pnpm db:check: src/db/tables.ts must match the schema the migrations build. Migrates a scratch database, then
// asks drizzle-kit what it would change to make that database match tables.ts; anything but "no changes" fails.
import { drizzleKitOnScratch } from './scratch-db.ts';

const { status, out } = drizzleKitOnScratch(['push', '--explain']);
if (status === 0 && /No changes detected/.test(out)) {
  console.log('db:check: src/db/tables.ts matches the migrated schema');
} else {
  console.error(`db:check: src/db/tables.ts and the migrations disagree:\n${out}`);
  process.exitCode = 1;
}
