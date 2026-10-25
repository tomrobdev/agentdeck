// drizzle-kit (dev only): Studio on the live database, and the schema check against a freshly migrated one.
// The daemon doesn't use Drizzle at runtime yet (docs/plans/drizzle.html); src/db/tables.ts mirrors db/schema.ts.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/tables.ts',
  out: process.env.DRIZZLE_OUT ?? './drizzle',
  dbCredentials: { url: process.env.DRIZZLE_DB ?? join(process.env.AGENTDECK_HOME ?? join(homedir(), '.agentdeck'), 'agentdeck.db') },
});
