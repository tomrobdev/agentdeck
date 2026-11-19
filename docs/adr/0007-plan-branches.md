# ADR 0007: Plan branches

Status: accepted, 2026-11-18

## Context

Every task lands on its own target, its repo's base unless it names another. A plan's tasks therefore reach the base
one by one, so a phase of several tasks (a King of Comps phase of nine tasks pinning payment, compliance, KYC and payout
code on a live site) is on the base half done until its last task merges. Most of AgentDeck's own plans land within a
day or two and never need more, so whatever we add must be opted into per plan, and must not assume one repo's
settings.

## Options considered

1. **A long-lived branch a person keeps by hand, set as each task's target.** Works today, but nobody cuts it, keeps
   it current with the base or lands it, and every task must name it. Rejected.
2. **Stacked task branches,** each task building on the one before. A chain of builds-on links already does this, and
   still lands each task on the base. Rejected.
3. **A plan branch the plan owns: one per (plan, repo), opened by a person, cut and kept by the daemon, landed as one
   pull request.** **Chosen.**

## Decision

- A plan branch is a row in `plan_branches`: the plan's task, the repo, its name, its base, its status, its head when
  last cut or synced, and its pull request. There is one per (plan task, repo); a unique index keeps it so.
- Its name is `plan/<plan task id>-<slug of the plan's title>` (`planBranchName`).
- Its life is a rule table, `PLAN_BRANCH_MOVES` in `daemon/src/domain/work/plans/plan-branch.ts`: `open → active →
landing → landed`, with `conflict` (a sync it could not settle) and `abandoned`; `partly_landed` is reserved for plans
  across repos. Every status change is a guarded `UPDATE … WHERE status IN (…)` in `db/work/plan-branches.ts`, as a
  task's is, and `docs/reference/state-machines.md` lists the table.
- `agentdeck plan-branch open <plan task>` (or the plan card's button) opens one in the plan's repo. Every task that
  follows the plan there, names no target and has not started takes it as its target, in the same transaction; a task
  added later with `--plan <n>` takes it too, unless it names a target.
- It is opened, not cut: the daemon cuts it from the base and pushes it (when the repo has an origin) as the first task
  targeting it starts, so a plan that never starts leaves no branch behind.
- `agentdeck plan-branch abandon <plan task>` closes it. Its tasks that have not started move back to the base; a task
  that has a branch keeps its target, since a branch's target is fixed. It is refused while a task on it runs, checked
  in the same transaction as the move.
- A plan branch is single use: once landed or abandoned it is never reopened or reused, so any merge method is safe for
  it.

## Consequences

- Where work lands is a choice per plan; the default stays the base.
- A person lands a plan branch in phase 1. Syncing it with its base, its pull request, and the doctor's checks of CI on
  `plan/**` come in the plan's later steps.
- A plan whose plan branch was abandoned cannot open another one in that repo: open a new plan instead.
