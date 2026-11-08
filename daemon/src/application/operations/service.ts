// The launchd service the daemon runs under, for the CLI's daemon commands and the API: each call goes to the app's
// Service port. They throw an Error with a message fit to print when launchd refuses.
import type { App } from '../ports/app.ts';

export const serviceStatus = (app: App) => app.service.status();
export const startService = (app: App) => app.service.start();
export const stopService = (app: App) => app.service.stop();
export const restartService = (app: App) => app.service.restart();
export const installService = (app: App) => app.service.install();
export const uninstallService = (app: App) => app.service.uninstall();
export const tailDaemonLog = (app: App, lines: number, follow: boolean) => app.service.tailLog(lines, follow);

/** A run's log, read into its entries. */
export const readLog = (app: App, path: string) => app.runLog.read(path);
