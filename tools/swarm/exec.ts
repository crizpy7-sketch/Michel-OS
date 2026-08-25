/** Thin child_process wrapper. Never throws on non-zero exit — the gauntlet
 *  treats a failing command as evidence, not as a crash. */
import { spawn } from 'node:child_process';

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function sh(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): Promise<ShResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 180_000);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}
