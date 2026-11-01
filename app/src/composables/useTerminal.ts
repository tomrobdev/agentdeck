import { onMounted, ref } from 'vue';
import { addTaskCommand, CMUX_TEMPLATE, terminalArgv, terminalTemplate } from '../lib/terminal';
import { cmuxInstalled, isNative, openTerminal } from '../platform/native';

/** Opening a terminal from the dashboard: only in the desktop app, and with cmux installed or another command set. */
export function useTerminal() {
  const available = ref(false);
  onMounted(async () => {
    available.value = isNative && (terminalTemplate() !== CMUX_TEMPLATE || (await cmuxInstalled()));
  });

  /** A terminal in `cwd`, running `command` when given. */
  const open = (title: string, cwd: string, command?: string) => openTerminal(terminalArgv(), { title, cwd, command });
  /** A terminal in the repo running Claude's add-task skill, with what has been typed so far. */
  const writeTask = (repo: string, cwd: string, typed: string) => open(`New task: ${repo}`, cwd, addTaskCommand(typed));
  const name = () => (terminalTemplate() === CMUX_TEMPLATE ? 'cmux' : 'terminal');
  return { available, open, writeTask, name };
}
