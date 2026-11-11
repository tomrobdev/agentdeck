// A value the code knows is there, checked: in place of a non-null assertion, it throws naming what was missing.
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}
