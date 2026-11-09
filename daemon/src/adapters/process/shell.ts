// Runs a repo's own commands (setup, tests) through the shell.
import { spawn } from 'node:child_process';
import { withToolchainPath } from '../../config.ts';

const TAIL_BYTES = 20_000;

/** Run a repo command in `cwd`. Never rejects: a failure or timeout is `passed: false`. */
export function runCommand(cmd: string, cwd: string, timeout: number): Promise<{ passed: boolean; output: string }> {
  return runProgram('sh', ['-c', cmd], cwd, timeout);
}

/**
 * Run a program with arguments, no shell in between. It gets its own process group, which a timeout kills whole, so a
 * hung test suite leaves nothing behind. Only the tail of the output is kept, however much there is.
 * Never rejects: a failure or timeout is `passed: false`.
 */
export function runProgram(file: string, args: string[], cwd: string, timeout: number): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES * 2) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    const finish = (passed: boolean, note: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = tail.subarray(Math.max(0, tail.length - TAIL_BYTES)).toString();
      resolve({ passed, output: output || note });
    };
    const killGroup = (pid: number | undefined) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };

    let pid: number | undefined;
    let timer: NodeJS.Timeout;
    try {
      const child = spawn(file, args, {
        cwd,
        env: withToolchainPath() as NodeJS.ProcessEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pid = child.pid;
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(pid);
      }, timeout);
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', (err) => finish(false, err.message));
      child.on('close', (code, signal) => {
        // Anything the command left running in its group goes with it.
        killGroup(pid);
        if (timedOut) finish(false, `timed out after ${timeout} ms`);
        else if (code === 0) finish(true, '');
        else finish(false, signal ? `killed by ${signal}` : `exited with code ${code}`);
      });
    } catch (err) {
      timer = setTimeout(() => {}, 0);
      finish(false, err instanceof Error ? err.message : String(err));
    }
  });
}
