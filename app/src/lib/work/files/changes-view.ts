// What the Changes tab derives from its files and comments. Pure, so the daemon's tests can import it
// (daemon/test/dashboard/work/files/changes-view.test.ts).

/** The lines added and deleted across `files`. */
export function totalLines(files: { additions: number; deletions: number }[]): { add: number; del: number } {
  return files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
}

/**
 * The comments to show on a file. Since a point the old side is that point's file, not the base's, so only the new
 * side's comments show there.
 */
export function visibleComments<C extends { side: string }>(comments: C[] | undefined, sincePoint: boolean): C[] | undefined {
  return sincePoint ? comments?.filter((c) => c.side === 'new') : comments;
}
