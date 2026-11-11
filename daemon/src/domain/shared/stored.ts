// A task or run as its columns, and the API, keep it: JSON text for the documents, 1 or 0 for the flags.

const JSON_FIELDS = [
  'needs',
  'question',
  'plan_steps',
  'auto_merge_check',
  'merge_request_check',
  'pr_checks',
  'pr_checks_opened',
  'pr_checks_merged',
];
type JsonField =
  'needs' | 'question' | 'plan_steps' | 'auto_merge_check' | 'merge_request_check' | 'pr_checks' | 'pr_checks_opened' | 'pr_checks_merged';

type Stored<T> = {
  [K in keyof T]: K extends JsonField
    ? Extract<T[K], null | undefined> | string
    : K extends 'auto_merge' | 'tests_passed'
      ? Extract<T[K], null | undefined> | number
      : T[K];
};

export function stored<T extends object>(fields: T): Stored<T> {
  const f = fields as Record<string, unknown>;
  const out: Record<string, unknown> = { ...f };
  for (const key of JSON_FIELDS) if (key in f) out[key] = f[key] == null ? null : JSON.stringify(f[key]);
  for (const key of ['auto_merge', 'tests_passed']) if (key in f) out[key] = f[key] == null ? null : f[key] ? 1 : 0;
  return out as Stored<T>;
}
