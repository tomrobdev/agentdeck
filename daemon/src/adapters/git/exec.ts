// Running git: the one way every other git file starts a process.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * A git command that talks to a remote. It must never wait for a person: the daemon runs without a
 * terminal, and a credential prompt would keep the task's slot forever. So prompts are off and it times out.
 */
export async function gitRemote(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

// Reading commits, trees and files. These read git objects only, never a worktree's files, so they
// work after the worktree is gone and never show uncommitted work. Paths come after `--` and are
// taken literally (no pathspec magic such as `:(top)` or globs).

export const READ_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
// Diffs look the same whatever the person's git config says.
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

/** Like `git`, for reads: untrimmed output and literal pathspecs. */
export async function gitRead(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: READ_ENV });
  return stdout;
}

/** Run git and keep at most `limit` bytes of its output, stopping it once there is more. */
export function gitCapped(cwd: string, limit: number, args: string[]): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: READ_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      if (truncated) return;
      chunks.push(c);
      size += c.length;
      if (size > limit) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !truncated) return reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
      const all = Buffer.concat(chunks);
      resolve({ bytes: truncated ? all.subarray(0, limit + 1) : all, truncated });
    });
  });
}

/** Run git with `input` on its stdin and return its output. */
export function gitWithInput(cwd: string, input: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: READ_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`))));
    child.stdin.on('error', () => {}); // git may exit before reading all of it; its exit code says how it went
    child.stdin.end(input);
  });
}
