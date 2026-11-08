// Builds the App the use cases take, on the database and the real adapters: for the CLI (`cli.ts`), which also hands
// it to the daemon (`cli/daemon.ts` → `daemon.ts`). Tests build theirs in test/fixtures.ts. Each process builds one,
// so nothing here is module state.
import type { App, Ports } from './application/ports/app.ts';
import { type Db, openDb } from './db/index.ts';

/**
 * The App the entry points are given: the use cases' App, plus the rest of what the database offers that the entry
 * points still call directly (`close`, and the store calls the strict-layers step replaces with use cases).
 */
export type ComposedApp = Db & App;

/** The ports on the real adapters. None yet: each port that lands adds its adapter here. */
export const realPorts = (): Ports => ({});

/** Open the database (the live one unless `path` names another) and build the App on it. */
export function composeApp(path?: string): ComposedApp {
  return Object.assign(openDb(path), realPorts());
}
