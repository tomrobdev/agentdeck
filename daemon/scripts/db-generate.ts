// pnpm db:generate: prints the SQL drizzle-kit would run to make a freshly migrated database match src/db/tables.ts,
// to start a new migration step from. Changes nothing and exits 0; no statements means the two already agree.
import { drizzleKitOnScratch } from './scratch-db.ts';

const { out } = drizzleKitOnScratch(['push', '--explain']);
console.log(out.trim());
