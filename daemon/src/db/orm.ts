// The Drizzle handle the ported stores use, on the same DatabaseSync connection as the raw ones.
import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

export const makeOrm = (client: DatabaseSync) => drizzle({ client });
export type Orm = ReturnType<typeof makeOrm>;
