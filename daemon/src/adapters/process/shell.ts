// Runs a repo's own commands (setup, tests) through the shell.
import { spawn } from 'node:child_process';
import { withToolchainPath } from '../../config.ts';

const TAIL_BYTES = 20_000;

export function runCommand(cmd: string, cwd: string, timeout: number): Promise<{ passed: boolean; output: string }> {
  return runProgram('sh', ['-c', cmd], cwd, timeout);
}

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
      } catch {}
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
