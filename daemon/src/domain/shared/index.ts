// The shared context's interface: what other contexts and the layers above import.
export { asRepoId, asRunId, asTaskId, parseId } from '#domain/shared/id.ts';
export type { PlannerRunId, RepoId, ReviewId, RunId, TaskId } from '#domain/shared/id.ts';
export {
  STATUS_TAIL,
  STATUS_WORD,
  cut,
  errorMessage,
  lastLine,
  oneLine,
  parseTextList,
  plural,
  short,
  textList,
  wholeNumberError,
} from '#domain/shared/text.ts';
export { present } from '#domain/shared/present.ts';
export { stored } from '#domain/shared/stored.ts';
export { median, minutesBetween, sqliteMs, sqliteUtc, weekOf } from '#domain/shared/time.ts';
