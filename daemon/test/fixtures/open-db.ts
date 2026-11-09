// `openDb` for tests that hand the database to use cases: it returns an App (`Db & App`), on the real ports unless a test
// replaces them with `testApp(db, ports)`. Import it after AGENTDECK_HOME is set, as `src/db/index.ts` itself.
import { openDb as open } from '../../src/db/index.ts';
import { testApp } from './fixtures.ts';

export const openDb = (path?: string) => testApp(open(path));
