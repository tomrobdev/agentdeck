// Keeps the Mac from idle-sleeping while agents work, with a `caffeinate -i` assertion.
import { type ChildProcess, spawn } from 'node:child_process';

export class KeepAwake {
  private child: ChildProcess | null = null;
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled && process.platform === 'darwin';
  }

  set(on: boolean): void {
    if (!this.enabled) return;
    if (on && !this.child) {
      this.child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.child.on('exit', () => (this.child = null));
    } else if (!on && this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
