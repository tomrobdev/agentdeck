// Running git: the one way every other git file starts a process.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function gitRemote(cwd: string, timeoutMs: number, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

export const READ_ENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

export async function gitRead(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: READ_ENV });
  return stdout;
}

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

export function gitWithInput(cwd: string, input: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: READ_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
