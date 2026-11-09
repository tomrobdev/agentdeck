// Per-browser view settings in localStorage, under an `agentdeck.` prefix.

/** Reads and writes never throw: storage can be missing or full. */
export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`agentdeck.${key}`);
    if (raw === null) return fallback;
    const v = JSON.parse(raw);
    return typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback) ? { ...fallback, ...v } : v;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(`agentdeck.${key}`, JSON.stringify(value));
  } catch {
    // The view just won't be remembered.
  }
}
