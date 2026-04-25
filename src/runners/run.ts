import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ExecutionContext } from '../engine/context';
import { registerRunner, type TaskRunner } from './base';

export interface RunShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class RunDispatcher implements TaskRunner {
  async run(ctx: ExecutionContext, body: Record<string, any>): Promise<unknown> {
    const cfg = body.run;
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('run: requires a configuration object');
    }
    if (cfg.shell) return runShell(ctx, cfg.shell);
    throw new Error('run: only `run.shell` is supported');
  }
}

async function runShell(ctx: ExecutionContext, shellCfg: unknown): Promise<RunShellResult> {
  const evaluated = (await ctx.evalValue(shellCfg)) as {
    command?: unknown;
    stdin?: unknown;
    environment?: Record<string, unknown>;
    interactive?: unknown;
  };

  const command = evaluated.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('run.shell requires a non-empty string `command`');
  }

  const interactive = evaluated.interactive !== false;
  if (interactive && typeof evaluated.stdin === 'string') {
    throw new Error('run.shell: `interactive` and `stdin` cannot be used together');
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(evaluated.environment ?? {})) {
    env[k] = String(v);
  }

  if (interactive) return runShellInteractive(ctx, command, env);

  return new Promise<RunShellResult>((resolve, reject) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: ctx.workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const onAbort = () => {
      // Kill the whole process group so that child processes (e.g. `sleep`
      // spawned by the shell) also terminate. Falls back to killing the shell
      // alone if the group kill fails.
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
      } catch {
        proc.kill();
      }
    };
    ctx.signal?.addEventListener('abort', onAbort);
    const cleanup = () => ctx.signal?.removeEventListener('abort', onAbort);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // Decode per-chunk via StringDecoder so a multibyte UTF-8 sequence split
    // across two `data` events doesn't surface as U+FFFD in the streamed
    // output. Trailing bytes are buffered inside the decoder until the next
    // write() completes the sequence (or .end() flushes whatever remains).
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    proc.stdout.on('data', (c: Buffer) => {
      stdoutChunks.push(c);
      const s = stdoutDecoder.write(c);
      if (s) ctx.shellEmit.stdout?.(s);
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderrChunks.push(c);
      const s = stderrDecoder.write(c);
      if (s) ctx.shellEmit.stderr?.(s);
    });

    proc.once('error', (err) => {
      cleanup();
      reject(err);
    });

    proc.once('close', (code, signal) => {
      cleanup();
      const tailOut = stdoutDecoder.end();
      if (tailOut) ctx.shellEmit.stdout?.(tailOut);
      const tailErr = stderrDecoder.end();
      if (tailErr) ctx.shellEmit.stderr?.(tailErr);
      // Mirror shell convention: a signal-terminated process reports 128 + N.
      const finalCode = code ?? (signal ? 128 : 1);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code: finalCode,
      });
    });

    if (typeof evaluated.stdin === 'string') {
      proc.stdin.end(evaluated.stdin);
    } else {
      proc.stdin.end();
    }
  });
}

async function runShellInteractive(
  ctx: ExecutionContext,
  command: string,
  env: Record<string, string>,
): Promise<RunShellResult> {
  // The child takes over the controlling TTY, so the TUI must be unmounted
  // first; the runner waits for the suspend hook to resolve before the spawn.
  await ctx.shellEmit.interactiveStart?.();
  try {
    return await new Promise<RunShellResult>((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], {
        cwd: ctx.workDir,
        env,
        stdio: 'inherit',
        detached: true,
      });

      const onAbort = () => {
        try {
          if (proc.pid !== undefined) process.kill(-proc.pid, 'SIGTERM');
        } catch {
          proc.kill();
        }
      };
      ctx.signal?.addEventListener('abort', onAbort);
      const cleanup = () => ctx.signal?.removeEventListener('abort', onAbort);

      proc.once('error', (err) => {
        cleanup();
        reject(err);
      });

      proc.once('close', (code, signal) => {
        cleanup();
        const finalCode = code ?? (signal ? 128 : 1);
        resolve({ stdout: '', stderr: '', code: finalCode });
      });
    });
  } finally {
    await ctx.shellEmit.interactiveEnd?.();
  }
}

registerRunner('run', () => new RunDispatcher());
