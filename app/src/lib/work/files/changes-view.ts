export function totalLines(files: { additions: number; deletions: number }[]): { add: number; del: number } {
  return files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });
}

export function visibleComments<C extends { side: string }>(comments: C[] | undefined, sincePoint: boolean): C[] | undefined {
  return sincePoint ? comments?.filter((c) => c.side === 'new') : comments;
}
