import { onMounted, ref } from 'vue';
import { addTaskCommand, CMUX_TEMPLATE, terminalArgv, terminalTemplate } from '#lib/runs/terminal.ts';
import { cmuxInstalled, isNative, runTemplate } from '#platform/native.ts';

export function useTerminal() {
  const available = ref(false);
  onMounted(async () => {
    available.value = isNative && (terminalTemplate() !== CMUX_TEMPLATE || (await cmuxInstalled()));
  });

  const open = (title: string, cwd: string, command?: string) => runTemplate(terminalArgv(), { title, cwd, command });
  const writeTask = (repo: string, cwd: string, typed: string) => open(`New task: ${repo}`, cwd, addTaskCommand(typed));
  const name = () => (terminalTemplate() === CMUX_TEMPLATE ? 'cmux' : 'terminal');
  return { available, open, writeTask, name };
}
