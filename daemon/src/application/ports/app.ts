// The one object every use case takes: the repositories and the other ports, built by the composition root
// (`src/compose.ts` for the daemon and the CLI, `test/fixtures.ts` for tests). Use cases keep no state of their own:
// what they need arrives on `app`.
import type { Repositories } from './repositories.ts';

/**
 * The ports besides the repositories, each an interface application/ owns. None yet: the use cases still import their
 * adapters, and Agent, CodeHost, Workspace and the rest join here one at a time.
 */
export interface Ports {}

/** What the use cases take: the repositories and the ports, one object. */
export type App = Repositories & Ports;
