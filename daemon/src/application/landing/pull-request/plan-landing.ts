// Landing a plan's plan branches: reading each plan PR, merging the next one its landing policy allows, settling a failure partway, and a person's answer to it.
import type { App } from '#application/ports/app.ts';
import { type PrDetails, mergeFailure, planPrCheck } from '#domain/landing/index.ts';
import { type Repo, pausedReason } from '#domain/repos/index.ts';
import { type TaskId, errorMessage } from '#domain/shared/index.ts';
import {
  DEFAULT_LANDING_POLICY,
  LANDING_ANSWERS,
  LANDING_POLICIES,
  type LandingAnswer,
  type LandingBranch,
  type LandingChange,
  type LandingQuestion,
  type PlanBranch,
  afterLandingMerge,
  afterPlanPrState,
  isLandingAnswer,
  isLandingPolicy,
  isLivePlanBranch,
  landingAnswerMove,
  landingOrder,
  landingOrderError,
  landingQuestion,
  nextLandingStep,
  partlyLandedLine,
  revertFrom,
} from '#domain/work/index.ts';
import { notifyLater } from '#application/operations/notifications.ts';
import { ActionError, object } from '#application/shared/input.ts';
import { planBranchesFor } from '#application/work/plans.ts';

const MAX_STEPS = 10;

interface Read {
  branch: PlanBranch;
  repo: Repo;
  pr: PrDetails | null;
}

type Log = (msg: string) => void;

async function readPlan(app: App, branches: PlanBranch[], log: Log): Promise<Read[]> {
  const reads: Read[] = [];
  for (const branch of branches) {
    const repo = app.getRepo(branch.repo_id);
    if (!repo) continue;
    if ((branch.status !== 'landing' && branch.status !== 'partly_landed') || !branch.pr_url) {
      reads.push({ branch, repo, pr: null });
      continue;
    }
    const pr = await app.codeHost.prDetails(branch.pr_url, repo.path).catch((err) => {
      log(`plan branch ${branch.name}: could not read its PR: ${errorMessage(err)}`);
      return null;
    });
    reads.push({ branch, repo, pr });
  }
  return reads;
}

function sagaView(reads: Read[], paused: (repo: Repo) => string | null): LandingBranch[] {
  return reads.map(({ branch, repo, pr }) => {
    const check = pr?.state === 'open' ? planPrCheck(pr, paused(repo)) : null;
    return {
      id: branch.id,
      name: branch.name,
      repo: repo.name,
      status: branch.status,
      land_order: branch.land_order,
      land_error: branch.land_error,
      verdict: check?.verdict ?? null,
      reason: check?.reasons[0]?.text ?? null,
    };
  });
}

const landedAt = (read: Read, pr: PrDetails | null) => {
  const commit = pr?.merge_commit ?? null;
  return { commit, from: commit ? revertFrom(commit, read.repo.merge_method, pr?.commits ?? 1) : null };
};

async function settled(app: App, read: Read, change: LandingChange, pr: PrDetails | null, log: Log): Promise<boolean> {
  const moved = app.recordLanding(read.branch.id, change, change.move === 'land' ? landedAt(read, pr) : null);
  if (!moved || !change.move) return false;
  const { name, base } = read.branch;
  if (change.move === 'close_pr') log(`plan branch ${name}: its PR was closed unmerged, so it is active again`);
  if (change.move === 'part_land') askAboutPartLanding(app, moved, log);
  if (change.move !== 'land') return true;
  log(`plan branch ${name} in ${read.repo.name}: landed on ${base}`);
  await app.codeHost
    .deleteRemoteBranch(read.repo.path, name)
    .catch((err) => log(`plan branch ${name}: remote branch not deleted: ${errorMessage(err)}`));
  await app.workspace
    .removeCheckout(read.repo, { branch: name })
    .catch((err) => log(`plan branch ${name}: local branch not deleted: ${errorMessage(err)}`));
  return true;
}

function askAboutPartLanding(app: App, branch: PlanBranch, log: Log): void {
  const names = new Map(app.listRepos().map((r) => [r.id, r.name]));
  const branches = app.planBranchesOfPlan(branch.plan_task).map((b) => ({ ...b, repo: names.get(b.repo_id) ?? `repo ${b.repo_id}` }));
  const text = partlyLandedLine(branches, branch.plan_task);
  log(`plan branch ${branch.name}: partly landed: ${text}`);
  notifyLater(app, { kind: 'blocked', title: `${branch.name} partly landed`, body: text, task_id: branch.plan_task });
}

async function mergeNext(app: App, read: Read): Promise<{ change: LandingChange; pr: PrDetails | null }> {
  const { branch, repo, pr } = read;
  const branches = app.planBranchesOfPlan(branch.plan_task);
  const policy = branch.landing_policy;
  if (!branch.pr_url || !pr?.head) return { change: { move: null, land_error: null }, pr: null };
  try {
    await app.codeHost.merge({ url: branch.pr_url, cwd: repo.path, method: repo.merge_method, head: pr.head });
  } catch (err) {
    const error = errorMessage(err);
    return { change: afterLandingMerge(policy, branches, branch.id, { failure: mergeFailure(error), error }), pr: null };
  }
  const after = await app.codeHost.prDetails(branch.pr_url, repo.path).catch(() => null);
  return { change: afterLandingMerge(policy, branches, branch.id, { merged: true }), pr: after };
}

async function landPlan(app: App, plan: TaskId, log: Log, ignorePause: boolean): Promise<number> {
  let landed = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const branches = app.planBranchesOfPlan(plan);
    const policy = branches[0]?.landing_policy ?? DEFAULT_LANDING_POLICY;
    const reads = await readPlan(app, branches, log);
    let moved = false;
    for (const read of reads) {
      const change = read.pr && afterPlanPrState(policy, app.planBranchesOfPlan(plan), read.branch.id, read.pr.state);
      if (change && (await settled(app, read, change, read.pr, log))) {
        moved = true;
        if (change.move === 'land') landed++;
      }
    }
    if (moved) continue;
    const paused = (repo: Repo) => (ignorePause ? null : pausedReason(app.isPaused(), repo));
    const next = nextLandingStep(policy, sagaView(reads, paused));
    if (next.kind === 'fail') {
      const read = reads.find((r) => r.branch.id === next.branch);
      if (read) await settled(app, read, { move: 'part_land', land_error: next.error }, null, log);
      return landed;
    }
    if (next.kind !== 'merge') return landed;
    const read = reads.find((r) => r.branch.id === next.branch);
    if (!read) return landed;
    log(`plan branch ${read.branch.name} in ${read.repo.name}: merging its plan PR (${policy})`);
    const { change, pr } = await mergeNext(app, read);
    if (change.land_error) log(`plan branch ${read.branch.name}: merge failed: ${change.land_error}`);
    const went = await settled(app, read, change, pr, log);
    if (change.move === 'land' && went) landed++;
    if (change.move !== 'land') return landed;
  }
  return landed;
}

export async function landPlanBranches(app: App, log: Log = () => {}, opts: { ignorePause?: boolean } = {}): Promise<number> {
  const plans = [...new Set(app.landingPlanBranches().map((b) => b.plan_task))];
  let landed = 0;
  for (const plan of plans) {
    landed += await landPlan(app, plan, log, opts.ignorePause ?? false).catch((err) => {
      log(`plan #${plan}: landing crashed: ${errorMessage(err)}`);
      return 0;
    });
  }
  return landed;
}

export function planLandingQuestion(app: App, id: TaskId): { question: LandingQuestion | null } {
  const { branches } = planBranchesFor(app, id);
  const names = new Map(app.listRepos().map((r) => [r.id, r.name]));
  return { question: landingQuestion(branches.map((b) => ({ ...b, repo: names.get(b.repo_id) ?? `repo ${b.repo_id}` }))) };
}

export function setPlanLandingPolicy(app: App, id: TaskId, input: unknown): PlanBranch[] {
  const { owner, branches } = planBranchesFor(app, id);
  const { policy, order = [] } = object(input);
  if (!isLandingPolicy(policy)) throw new ActionError(`a landing policy is one of: ${LANDING_POLICIES.join(', ')}`);
  if (!Array.isArray(order) || !order.every((r) => typeof r === 'string')) throw new ActionError('the order is a list of repo names');
  if (order.length && policy !== 'in_order') throw new ActionError('only an in_order plan takes an order');
  const names = new Map(app.listRepos().map((r) => [r.id, r.name]));
  const repoOf = (b: PlanBranch) => names.get(b.repo_id) ?? `repo ${b.repo_id}`;
  const error = landingOrderError(order, branches.map(repoOf));
  if (error) throw new ActionError(error);
  const rank = (b: PlanBranch) => (order.includes(repoOf(b)) ? order.indexOf(repoOf(b)) : null);
  return landingOrder(
    app.setLandingPolicy(
      owner.id,
      policy,
      branches.map((b) => ({ id: b.id, land_order: rank(b) })),
    ),
  );
}

export async function answerPlanLandingInput(app: App, id: TaskId, input: unknown): Promise<LandingAnswered> {
  const { answer } = object(input);
  if (!isLandingAnswer(answer)) throw new ActionError(`an answer is one of: ${LANDING_ANSWERS.join(', ')}`);
  return answerPlanLanding(app, id, answer);
}

export interface LandingAnswered {
  answer: LandingAnswer;
  branches: PlanBranch[];
  reverts: { repo: string; url: string }[];
  unreverted: string[];
}

export async function answerPlanLanding(app: App, id: TaskId, answer: LandingAnswer): Promise<LandingAnswered> {
  const { owner, branches } = planBranchesFor(app, id);
  const partly = branches.filter((b) => b.status === 'partly_landed');
  if (!partly.length)
    throw new ActionError(`#${owner.id}'s plan is not partly landed, so there is nothing to answer`, undefined, 'conflict');
  const to = landingAnswerMove(answer);
  if (to === 'retry' || to === 'by_hand') {
    const answered = partly.flatMap((b) => app.answerLanding(b, to) ?? []);
    return { answer, branches: answered, reverts: [], unreverted: [] };
  }
  const abandoned: PlanBranch[] = [];
  for (const b of branches.filter(isLivePlanBranch)) {
    const outcome = app.abandonPlanBranch(b);
    if (outcome && 'refused' in outcome) throw new ActionError(outcome.refused, undefined, 'conflict');
    if (!outcome) continue;
    abandoned.push(outcome.abandoned);
    const repo = app.getRepo(b.repo_id);
    if (b.pr_url && repo) await app.codeHost.closePr(b.pr_url, repo.path).catch(() => {});
  }
  const reverts: LandingAnswered['reverts'] = [];
  const unreverted: string[] = [];
  for (const b of branches.filter((x) => x.status === 'landed')) {
    const repo = app.getRepo(b.repo_id);
    if (!repo) continue;
    const url = await openRevertPr(app, repo, b).catch(() => null);
    if (url) reverts.push({ repo: repo.name, url });
    else unreverted.push(repo.name);
  }
  return { answer, branches: abandoned, reverts, unreverted };
}

async function openRevertPr(app: App, repo: Repo, branch: PlanBranch): Promise<string | null> {
  const { landed_commit: to, landed_from: from } = branch;
  if (!to || !from) return null;
  const head = `revert/${branch.name}`;
  const message = `Revert ${branch.name}`;
  const sha = await app.workspace.withScratchCheckout(repo, branch.base, async (checkout) => {
    if ('error' in checkout) throw new Error(checkout.error);
    return app.workspace.revertChange(checkout.path, head, { from, to, message });
  });
  if (!sha) return null;
  await app.codeHost.push(repo.path, head);
  const body = `Reverts \`${branch.name}\`, which landed on \`${branch.base}\` while its plan landed in only some repos (#${branch.plan_task}'s plan).`;
  return app.codeHost.createPr({ cwd: repo.path, base: branch.base, head, title: message, body, draft: false, labels: [] });
}
