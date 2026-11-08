// The layers of daemon/src and which of them each may import: the one source of the architecture test's rule and of
// the Layers section of docs/architecture.md. Imports point down CLAUDE.md's Boundaries list. Changing a layer here
// changes both: run `pnpm docs:gen` afterwards.

export interface Layer {
  /** What the layer holds, in a line. */
  holds: string;
  /** The layers it may import, besides itself. */
  imports: string[];
  /** Why that is all it may import. */
  why: string;
}

/** The layer a file belongs to: its top folder under src/, or the file itself for `config.ts`, `compose.ts`, `daemon.ts` and `cli.ts`. */
export const layerOf = (path: string) => (path.includes('/') ? path.split('/')[0] : path);

export const LAYERS: Record<string, Layer> = {
  domain: {
    holds: 'Entities and decisions, pure: task lifecycle, governor, prompts, plans',
    imports: [],
    why: 'domain/ is pure and imports no other layer',
  },
  'config.ts': {
    holds: 'Paths and constants',
    imports: [],
    why: 'config.ts is read by every layer and imports none',
  },
  db: {
    holds: 'Every SQL query, through Drizzle, and the migrations',
    imports: ['domain', 'config.ts'],
    why: 'db/ holds the SQL and knows only the domain',
  },
  adapters: {
    holds: 'The I/O: claude, git, gh, processes, shell, notifications, launchd, run logs',
    imports: ['domain', 'config.ts'],
    why: 'adapters import domain/ and config.ts only; they report through callbacks',
  },
  application: {
    holds: 'The use cases, connecting domain and adapters, and the repository interfaces they reach the database through',
    imports: ['adapters', 'domain', 'config.ts'],
    why: 'application/ reaches the database only through the repository interfaces it declares (application/ports/)',
  },
  'compose.ts': {
    holds: 'Builds the App the use cases take, on the database and the real adapters',
    imports: ['application', 'adapters', 'db', 'domain', 'config.ts'],
    why: 'compose.ts builds the App and uses no entry point',
  },
  api: {
    holds: "The dashboard's HTTP API",
    imports: ['application', 'compose.ts', 'db', 'domain', 'config.ts'],
    why: 'entry points reach adapters through application/',
  },
  cli: {
    holds: 'One file per command group of the agentdeck CLI',
    imports: ['api', 'application', 'compose.ts', 'db', 'domain', 'config.ts', 'daemon.ts'],
    why: 'entry points reach adapters through application/',
  },
  'daemon.ts': {
    holds: 'The composition root: wires the source watcher, the API and the scheduler',
    imports: ['api', 'application', 'adapters', 'compose.ts', 'db', 'domain', 'config.ts'],
    why: 'the composition root does not use the CLI',
  },
  'cli.ts': {
    holds: 'The CLI entry point the launchd plist runs',
    imports: ['cli', 'application', 'compose.ts', 'config.ts'],
    why: 'cli.ts only dispatches to cli/',
  },
};

/** Whether a file in layer `from` may import a file in layer `to`. */
export const mayImport = (from: string, to: string) => from === to || (LAYERS[from]?.imports.includes(to) ?? false);
