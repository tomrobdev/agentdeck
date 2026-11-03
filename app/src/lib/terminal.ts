// The terminal command setting: a template split into an argv list, never run through a shell.
import { loadSetting, saveSetting } from './storage';

/** Placeholders: {title} the workspace name, {cwd} its directory, {command} the text to run in it (dropped with its flag when none). */
export const CMUX_TEMPLATE = 'cmux new-workspace --name {title} --cwd {cwd} --command {command} --focus true';

/** Split on spaces; "double" or 'single' quotes keep spaces in one argument. No escapes, no expansion. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Quote one word for a POSIX shell: the text a terminal is told to run is typed into a shell. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** What "Write it with Claude" runs: the add-task skill with what was typed so far. */
export function addTaskCommand(text: string): string {
  const typed = text.trim();
  return `claude ${shellQuote(typed ? `/add-task ${typed}` : '/add-task')}`;
}

export function terminalTemplate(): string {
  return loadSetting('terminal', CMUX_TEMPLATE) || CMUX_TEMPLATE;
}

export function saveTerminalTemplate(text: string): void {
  saveSetting('terminal', text.trim() || CMUX_TEMPLATE);
}

export function terminalArgv(): string[] {
  return splitArgs(terminalTemplate());
}

/** Editor presets for Settings: {cwd} is the folder to open. There is no default. */
export const EDITOR_PRESETS = [
  { name: 'VS Code', template: 'code {cwd}' },
  { name: 'Cursor', template: 'cursor {cwd}' },
  { name: 'Zed', template: 'zed {cwd}' },
] as const;

/** The editor command template; empty until one is set. */
export function editorTemplate(): string {
  return loadSetting('editor', '');
}

export function saveEditorTemplate(text: string): void {
  saveSetting('editor', text.trim());
}

export function editorArgv(): string[] {
  return splitArgs(editorTemplate());
}
