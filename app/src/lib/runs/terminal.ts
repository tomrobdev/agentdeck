// The terminal command setting: a template split into an argv list, never run through a shell.
import { loadSetting, saveSetting } from '../shared/storage.ts';
import { isReview } from '../../../../daemon/src/domain/work/index.ts';
import type { TaskStatus } from '../../../../daemon/src/domain/work/index.ts';
import type { PrState } from '../../../../daemon/src/domain/landing/index.ts';

export const CMUX_TEMPLATE = 'cmux new-workspace --name {title} --cwd {cwd} --command {command} --focus true';

export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export function addTaskCommand(text: string): string {
  const typed = text.trim();
  return `claude ${shellQuote(typed ? `/add-task ${typed}` : '/add-task')}`;
}

export function fixTaskCommand(task: { id: number; status: TaskStatus; pr_state: PrState | null }, why: string): string {
  const skill = isReview(task) ? 'review-task' : 'triage';
  const reason = why.replace(/\s+/g, ' ').trim();
  return `claude ${shellQuote(`/${skill} ${task.id}${reason ? ` ${reason}` : ''}`)}`;
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

export const EDITOR_PRESETS = [
  { name: 'VS Code', template: 'code {cwd}' },
  { name: 'Cursor', template: 'cursor {cwd}' },
  { name: 'Zed', template: 'zed {cwd}' },
] as const;

export function editorTemplate(): string {
  return loadSetting('editor', '');
}

export function saveEditorTemplate(text: string): void {
  saveSetting('editor', text.trim());
}

export function editorArgv(): string[] {
  return splitArgs(editorTemplate());
}
