// The settings page.
import * as actions from '../../../application/actions.ts';
import type { Settings } from '../../contract/operations.ts';
import { type ApiContext, type Route, route } from '../../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route<Settings>('GET', /^\/api\/settings$/, () => actions.getSettings(db)),
    route<Settings>('POST', /^\/api\/settings$/, ({ body }) => actions.updateSettings(db, body)),
  ];
}
