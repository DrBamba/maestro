import type { ArchivePlan, RemoveRepoOptions } from './types'

export interface RemovalStep {
  removesWorktree: boolean
  deletesBranch: boolean
  /** Nothing on disk changes for this session; it is only hidden with the repo. */
  untouched: boolean
}

/**
 * What removing a repo does to one of its sessions. Shared by the dialog and main, so the counts a
 * user confirms are the steps that run.
 */
export function removalStep(plan: ArchivePlan, options: RemoveRepoOptions): RemovalStep {
  // With the clone going, every worktree goes — one left behind would point at a repo that is gone.
  // Its branches go with the clone, so they are not deleted one by one.
  if (options.deleteFolder) {
    return { removesWorktree: plan.canRemoveWorktree, deletesBranch: false, untouched: !plan.canRemoveWorktree }
  }
  const removesWorktree =
    options.removeWorktrees &&
    plan.canRemoveWorktree &&
    (!plan.worktreeIsForeign || options.allowForeign)
  // Never a branch Maestro did not create, and never one a kept worktree still has checked out.
  const deletesBranch =
    options.deleteBranches &&
    plan.branchOwned &&
    plan.canDeleteBranch &&
    (removesWorktree || plan.worktreeGone)
  // An archived session has nothing more to archive, and re-archiving would forget its stash.
  const untouched = !deletesBranch && (plan.archived || !removesWorktree)
  return {
    removesWorktree: removesWorktree && !untouched,
    deletesBranch,
    untouched
  }
}
