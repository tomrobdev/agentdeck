// Small text helpers. Pure: no I/O.

/** The message for a field that must be a whole number from `min` to `max`, or null when `value` is one. */
export function wholeNumberError(field: string, value: unknown, min: number, max: number): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return null;
  return `${field} must be a whole number from ${min} to ${max}`;
}

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
