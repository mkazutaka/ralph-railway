/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { RunDispatcher, type RunShellResult } from '../../src/runners/run';

test('run.shell: captures stdout and exit code', async () => {
  const ctx = new ExecutionContext({});
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'echo hello' } },
  })) as RunShellResult;
  expect(out.stdout).toBe('hello\n');
  expect(out.stderr).toBe('');
  expect(out.code).toBe(0);
});

test('run.shell: captures non-zero exit code without throwing', async () => {
  const ctx = new ExecutionContext({});
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'exit 3' } },
  })) as RunShellResult;
  expect(out.code).toBe(3);
});

test('run.shell: captures stderr separately', async () => {
  const ctx = new ExecutionContext({});
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'echo oops 1>&2; exit 1' } },
  })) as RunShellResult;
  expect(out.stdout).toBe('');
  expect(out.stderr).toBe('oops\n');
  expect(out.code).toBe(1);
});

test('run.shell: stdin is forwarded to the process', async () => {
  const ctx = new ExecutionContext({});
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'cat', stdin: 'piped\ninput' } },
  })) as RunShellResult;
  expect(out.stdout).toBe('piped\ninput');
  expect(out.code).toBe(0);
});

test('run.shell: environment vars are exposed to the command', async () => {
  const ctx = new ExecutionContext({});
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'echo "$GREETING"', environment: { GREETING: 'hola' } } },
  })) as RunShellResult;
  expect(out.stdout).toBe('hola\n');
});

test('run.shell: command is jq-evaluated against context', async () => {
  const ctx = new ExecutionContext({ input: { msg: 'evaluated' } });
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'echo ${ .input.msg }' } },
  })) as RunShellResult;
  expect(out.stdout).toBe('evaluated\n');
});

test('run.shell: missing command throws', async () => {
  const ctx = new ExecutionContext({});
  await expect(new RunDispatcher().run(ctx, { run: { shell: {} } })).rejects.toThrow(
    /requires a non-empty string `command`/,
  );
});

test('run: non-shell configurations throw', async () => {
  const ctx = new ExecutionContext({});
  await expect(
    new RunDispatcher().run(ctx, { run: { container: { image: 'alpine' } } }),
  ).rejects.toThrow(/only `run.shell` is supported/);
});

test('run.shell: streams stdout and stderr chunks through ctx.shellEmit', async () => {
  const ctx = new ExecutionContext({});
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  ctx.shellEmit = {
    stdout: (c) => stdoutChunks.push(c),
    stderr: (c) => stderrChunks.push(c),
  };
  const out = (await new RunDispatcher().run(ctx, {
    run: { shell: { command: 'echo out; echo err 1>&2' } },
  })) as RunShellResult;
  expect(out.stdout).toBe('out\n');
  expect(out.stderr).toBe('err\n');
  expect(stdoutChunks.join('')).toBe('out\n');
  expect(stderrChunks.join('')).toBe('err\n');
});

test('run.shell: aborts when the context signal fires', async () => {
  const controller = new AbortController();
  const ctx = new ExecutionContext({ signal: controller.signal });
  const pending = new RunDispatcher().run(ctx, {
    run: { shell: { command: 'sleep 5' } },
  }) as Promise<RunShellResult>;
  setTimeout(() => controller.abort(), 30);
  const out = await pending;
  // The process was killed: exit code is non-zero (typically SIGTERM -> 143).
  expect(out.code).not.toBe(0);
});
