// The settings page.
import * as actions from '../../application/actions.ts';
import type * as C from '../contract.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route<C.Settings>('GET', /^\/api\/settings$/, () => actions.getSettings(db)),
    route<C.Settings>('POST', /^\/api\/settings$/, ({ body }) => actions.updateSettings(db, body)),
  ];
}
