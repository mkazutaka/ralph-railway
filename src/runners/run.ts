import { spawn } from 'node:child_process';
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
  };

  const command = evaluated.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('run.shell requires a non-empty string `command`');
  }

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(evaluated.environment ?? {})) {
    env[k] = String(v);
  }

  return new Promise<RunShellResult>((resolve, reject) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: ctx.workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const onAbort = () => proc.kill();
    ctx.signal?.addEventListener('abort', onAbort);
    const cleanup = () => ctx.signal?.removeEventListener('abort', onAbort);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    proc.once('error', (err) => {
      cleanup();
      reject(err);
    });

    proc.once('close', (code, signal) => {
      cleanup();
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

registerRunner('run', () => new RunDispatcher());
