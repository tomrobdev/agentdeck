// A JSON value from claude's stream read as an object of unknown fields, so each field is checked before it is used.
export const fields = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export const text = (v: unknown): string => (typeof v === 'string' ? v : '');
