// The settings page.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route('GET', /^\/api\/settings$/, () => actions.getSettings(db)),
    route('POST', /^\/api\/settings$/, ({ body }) => actions.updateSettings(db, body)),
  ];
}
