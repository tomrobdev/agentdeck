// Runs a repo's own commands (setup, tests) through the shell.
import { execFile } from 'node:child_process';

/** Run a repo command in `cwd`. Never rejects: a failure or timeout is `passed: false`. */
export function runCommand(cmd: string, cwd: string, timeout: number): Promise<{ passed: boolean; output: string }> {
  return runProgram('sh', ['-c', cmd], cwd, timeout);
}

/** Run a program with arguments, no shell in between. Never rejects: a failure or timeout is `passed: false`. */
export function runProgram(file: string, args: string[], cwd: string, timeout: number): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.slice(-20_000);
      resolve({ passed: !err, output: output || (err ? err.message : '') });
    });
  });
}
