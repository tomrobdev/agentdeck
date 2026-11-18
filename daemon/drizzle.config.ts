// drizzle-kit (dev only): Studio on the live database, and the schema check and db:generate against a freshly
// migrated one. The daemon's stores query with drizzle-orm at runtime, being ported one at a time
//; migrations are still the steps in db/schema.ts, and src/db/tables.ts mirrors them.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/tables.ts',
  out: process.env.DRIZZLE_OUT ?? './drizzle',
  dbCredentials: { url: process.env.DRIZZLE_DB ?? join(process.env.AGENTDECK_HOME ?? join(homedir(), '.agentdeck'), 'agentdeck.db') },
});
