import { INSIGHTS_HELP } from '#cli/insights/help.ts';
import { LANDING_HELP } from '#cli/landing/help.ts';
import { CONTEXT_HELP, DAEMON_HELP, NOTIFY_HELP } from '#cli/operations/help.ts';
import { REPOS_HELP } from '#cli/repos/help.ts';
import { WORK_HELP } from '#cli/work/help.ts';

export const HELP = [
  'agentdeck: always-on Claude Code task queue',
  '',
  'Repos',
  REPOS_HELP,
  '',
  'Tasks',
  WORK_HELP,
  LANDING_HELP,
  CONTEXT_HELP,
  '',
  'Daemon',
  DAEMON_HELP,
  INSIGHTS_HELP,
  NOTIFY_HELP,
  '',
].join('\n');
