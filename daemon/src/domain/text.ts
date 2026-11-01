// Small text helpers. Pure: no I/O.

/** The message for a field that must be a whole number from `min` to `max`, or null when `value` is one. */
export function wholeNumberError(field: string, value: unknown, min: number, max: number): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return null;
  return `${field} must be a whole number from ${min} to ${max}`;
}

/** "1 check", "3 checks". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A list of text from a JSON column; `fallback` when it is not a JSON array. */
export function parseTextList(json: string | null | undefined, fallback: string[] = []): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : fallback;
  } catch {
    return fallback;
  }
}

/** A list from user input: comma or space separated, blanks dropped, duplicates removed. */
export function textList(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(/[\s,]+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
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
