// Small text helpers.

export function wholeNumberError(field: string, value: unknown, min: number, max: number): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return null;
  return `${field} must be a whole number from ${min} to ${max}`;
}

export function short(text: string, max: number): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function parseTextList(json: string | null | undefined, fallback: string[] = []): string[] {
  try {
    const v: unknown = JSON.parse(json ?? '');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : fallback;
  } catch {
    return fallback;
  }
}

export function textList(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(/[\s,]+/);
  return [...new Set(parts.map((s) => s.trim()).filter(Boolean))];
}

export const STATUS_WORD = String.raw`STATUS:\s*(DONE|BLOCKED)`;

export const STATUS_TAIL = new RegExp(String.raw`\n?[ \t]*${STATUS_WORD}\b.*$`, 'i');

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
