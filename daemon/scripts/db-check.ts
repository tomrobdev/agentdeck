import { drizzleKitOnScratch } from '#scripts/scratch-db.ts';

const { status, out } = drizzleKitOnScratch(['push', '--explain']);
if (status === 0 && /No changes detected/.test(out)) {
  console.log('db:check: src/db/tables.ts matches the migrated schema');
} else {
  console.error(`db:check: src/db/tables.ts and the migrations disagree:\n${out}`);
  process.exitCode = 1;
}
