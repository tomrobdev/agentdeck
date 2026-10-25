// The launchd service the daemon runs under, for the CLI's daemon commands.
export { install, restart, serviceStatus, start, stop, tailLog, uninstall } from '../adapters/service.ts';
