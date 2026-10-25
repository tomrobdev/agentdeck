// Small text helpers. Pure: no I/O.

/** The last non-empty line of a command's output, for a one-line reason. */
export function lastLine(output: string): string {
  return (
    output
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? 'no output'
  ).slice(0, 300);
}
