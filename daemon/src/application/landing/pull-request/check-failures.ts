// Why a failing GitHub Actions check failed: the step the job's steps name, and what that step's log says (`failureExcerpt`).
import type { App } from '#application/ports/app.ts';
import {
  EXCERPT_BYTES,
  type PrCheck,
  actionsRun,
  asNotRun,
  failedStep,
  failureExcerpt,
  notStartedMessage,
  stepUrl,
  withoutFailure,
} from '#domain/landing/index.ts';
import { errorMessage } from '#domain/shared/index.ts';

export async function readFailure(app: App, cwd: string, check: PrCheck, bytes = EXCERPT_BYTES): Promise<PrCheck> {
  const run = actionsRun(check.url);
  if (!run) return check;
  if (run.job) {
    const start = await app.codeHost.jobStart(cwd, run.job).catch(() => null);
    const notRun = start && notStartedMessage(start.job, start.annotations);
    if (notRun) return asNotRun(check, notRun);
  }
  const [steps, log] = await Promise.allSettled([
    run.job ? app.codeHost.jobSteps(cwd, run.job) : Promise.resolve([]),
    app.codeHost.failedLog(cwd, run.run, run.job),
  ]);
  const step = steps.status === 'fulfilled' ? failedStep(steps.value) : null;
  const read: PrCheck = { ...withoutFailure(check), step: step?.name ?? null, step_url: stepUrl(check.url, step) };
  if (log.status === 'rejected') return { ...read, excerpt_error: errorMessage(log.reason) };
  const excerpt = failureExcerpt(log.value, step?.name ?? null, bytes);
  return excerpt ? { ...read, excerpt } : { ...read, excerpt_error: 'gh printed no failed steps' };
}
