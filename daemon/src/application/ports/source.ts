// The Source port: the daemon's own source checkout, which it watches to notice it is running stale code.

export interface Source {
  commit(dir: string): Promise<string | null>;
  branch(dir: string): Promise<string | null>;
  dirty(file: string): Promise<boolean>;
  watch(dir: string, onChange: (file: string) => void): () => void;
}
