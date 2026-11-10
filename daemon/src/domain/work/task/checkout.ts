// Where a task's work is checked out.

/** A task's checkout: its branch and worktree, and when a sync of the branch began. A task with none of them has null. */
export interface Checkout {
  branch: string | null;
  worktree: string | null;
  syncing_since: string | null; // when a sync of the branch began; null when none is running
}

export function checkoutOf(fields: Checkout): Checkout | null {
  return fields.branch === null && fields.worktree === null && fields.syncing_since === null ? null : { ...fields };
}
