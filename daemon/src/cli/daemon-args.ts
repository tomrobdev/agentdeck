// Argument handling for the service, logs and restart commands, kept apart so it can be tested.
import { ActionError } from '../application/errors.ts';
import type { CommandContext } from './context.ts';

export type ServiceAction = 'status' | 'start' | 'stop';

/** `agentdeck service [start|stop]`: no argument shows the status. */
export function serviceAction(rest: string[]): ServiceAction {
  const [action, ...extra] = rest;
  if (action === undefined) return 'status';
  if ((action === 'start' || action === 'stop') && !extra.length) return action;
  throw new ActionError(`usage: agentdeck service [start|stop] (got "${rest.join(' ')}")`);
}

export const DEFAULT_LOG_LINES = 50;

/** `agentdeck logs [-f] [-n lines]`. */
export function logsOptions(flags: CommandContext['flags'], rest: string[]): { lines: number; follow: boolean } {
  if (rest.length) throw new ActionError('usage: agentdeck logs [-f] [-n lines]');
  const lines = flags.lines === undefined ? DEFAULT_LOG_LINES : Number(flags.lines);
  if (!Number.isInteger(lines) || lines < 0) throw new ActionError(`-n takes a whole number of lines, got "${flags.lines}"`);
  return { lines, follow: !!flags.follow };
}

/** `agentdeck restart [--now]`: graceful unless --now. */
export function restartOptions(flags: CommandContext['flags'], rest: string[]): { graceful: boolean } {
  if (rest.length) throw new ActionError('usage: agentdeck restart [--now]');
  return { graceful: !flags.now };
}
