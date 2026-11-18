import { openDb as open } from '#db/index.ts';
import { testApp } from '#test/fixtures/fixtures.ts';

export const openDb = (path?: string) => testApp(open(path));
