// The Drizzle handle every store uses, on the same DatabaseSync connection as the raw ones.
import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

export const makeOrm = (client: DatabaseSync) => drizzle({ client });
export type Orm = ReturnType<typeof makeOrm>;
