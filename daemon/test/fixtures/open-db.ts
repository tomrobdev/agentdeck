import { openDb as open } from '../../src/db/index.ts';
import { testApp } from './fixtures.ts';

export const openDb = (path?: string) => testApp(open(path));
