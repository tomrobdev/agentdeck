// The Source port: the daemon's own source checkout, which it watches to notice it is running stale code. The real adapters are
// adapters/git.ts and adapters/macos/watch.ts (compose.ts); tests run them on the real checkout.

export interface Source {
  /** The commit checked out in `dir`, or null when it is not a git checkout. */
  commit(dir: string): Promise<string | null>;
  /** The branch checked out in `dir`: 'detached' for a detached HEAD, null when it is not a git checkout. */
  branch(dir: string): Promise<string | null>;
  /** Whether `file` has uncommitted changes. */
  dirty(file: string): Promise<boolean>;
  /** Call `onChange` with the relative path of each changed .ts file under `dir`. Returns a function that stops watching. */
  watch(dir: string, onChange: (file: string) => void): () => void;
}
