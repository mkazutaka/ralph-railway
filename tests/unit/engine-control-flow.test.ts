/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
/** biome-ignore-all lint/suspicious/noThenProperty: `then` is the SLW DSL field name */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { WorkflowIterationLimitError } from '../../src/engine/errors';
import { Engine } from '../../src/engine/executor';
import { normalizeTaskList } from '../../src/engine/tasks';

test('for: iterates list and writes per-iteration scope', async () => {
  const tasks = normalizeTaskList([
    { collect: { set: { acc: [] } } },
    {
      loop: {
        for: { each: 'item', in: '${ .input.items }' },
        do: [{ tap: { set: { v: '${ .var.item }' } } }],
      },
    },
  ]);
  const ctx = new ExecutionContext({ input: { items: ['a', 'b', 'c'] } });
  await new Engine().runTaskList(tasks, ctx);
  // Each iteration overwrites the inner output (shared outputs map).
  expect(ctx.outputs.tap).toEqual({ v: 'c' });
});

test('for: at binds the index', async () => {
  const tasks = normalizeTaskList([
    {
      loop: {
        for: { each: 'item', at: 'idx', in: '${ .input.items }' },
        do: [{ tap: { set: { v: '${ .var.item }', i: '${ .var.idx }' } } }],
      },
    },
  ]);
  const ctx = new ExecutionContext({ input: { items: ['x', 'y'] } });
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.tap).toEqual({ v: 'y', i: 1 });
});

test('for.while: exits loop early when condition becomes false', async () => {
  // for iterates 1..100 but while terminates after init.n reaches 3.
  const tasks = normalizeTaskList([
    { init: { set: { n: 0 } } },
    {
      loop: {
        for: { each: 'tick', in: '${ [range(1; 101)] }' },
        while: '${ .output.init.n < 3 }',
        do: [{ init: { set: { n: '${ .output.init.n + 1 }' } } }],
      },
    },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.init).toEqual({ n: 3 });
});

test('for: iteration cap raises WorkflowIterationLimitError', async () => {
  const prev = process.env.RALPH_MAX_ITERATIONS;
  process.env.RALPH_MAX_ITERATIONS = '5';
  try {
    const tasks = normalizeTaskList([
      {
        loop: {
          for: { each: 'i', in: '${ [range(1; 101)] }' },
          do: [{ noop: { set: { x: 1 } } }],
        },
      },
    ]);
    const ctx = new ExecutionContext({});
    await expect(new Engine().runTaskList(tasks, ctx)).rejects.toThrow(WorkflowIterationLimitError);
  } finally {
    if (prev === undefined) delete process.env.RALPH_MAX_ITERATIONS;
    else process.env.RALPH_MAX_ITERATIONS = prev;
  }
});

test('switch: jumps forward to matching case', async () => {
  const tasks = normalizeTaskList([
    { setup: { set: { route: 'b' } } },
    {
      pick: {
        switch: [
          { caseA: { when: '${ .output.setup.route == "a" }', then: 'goa' } },
          { caseB: { when: '${ .output.setup.route == "b" }', then: 'gob' } },
        ],
      },
    },
    { goa: { set: { picked: 'a' } } },
    { gob: { set: { picked: 'b' } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.gob).toEqual({ picked: 'b' });
  expect(ctx.outputs.goa).toBeUndefined();
});

test('switch: default case fires when no when matches', async () => {
  const tasks = normalizeTaskList([
    {
      pick: {
        switch: [
          { only: { when: '${ false }', then: 'never' } },
          { fallback: { then: 'fallback' } },
        ],
      },
    },
    { never: { set: { hit: false } } },
    { fallback: { set: { hit: true } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.fallback).toEqual({ hit: true });
  expect(ctx.outputs.never).toBeUndefined();
});

test('switch: backward jump revisits earlier task', async () => {
  // Self-incrementing counter via prior output.
  const tasks = normalizeTaskList([
    { init: { set: { n: '${ ((.output.init.n // 0) + 1) }' } } },
    {
      decide: {
        switch: [
          { again: { when: '${ .output.init.n < 3 }', then: 'init' } },
          { done: { then: 'finish' } },
        ],
      },
    },
    { finish: { set: { final: '${ .output.init.n }' } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.init).toEqual({ n: 3 });
  expect(ctx.outputs.finish).toEqual({ final: 3 });
});

test('fork: runs branches in parallel and merges same-name outputs to array', async () => {
  const tasks = normalizeTaskList([
    {
      pf: {
        fork: {
          branches: [[{ work: { set: { side: 'left' } } }], [{ work: { set: { side: 'right' } } }]],
        },
      },
    },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(Array.isArray(ctx.outputs.work)).toBe(true);
  const arr = ctx.outputs.work as Array<{ side: string }>;
  expect(arr.map((x) => x.side).sort()).toEqual(['left', 'right']);
});

test('fork: failure in any branch rethrows', async () => {
  const tasks = normalizeTaskList([
    {
      pf: {
        fork: {
          branches: [[{ ok: { set: { x: 1 } } }], [{ boom: { call: 'nope' } }]],
        },
      },
    },
  ]);
  const ctx = new ExecutionContext({});
  await expect(new Engine().runTaskList(tasks, ctx)).rejects.toThrow(/nope is not supported/);
});

test('try/catch: swallows error and runs catch.do with bound error var', async () => {
  const tasks = normalizeTaskList([
    {
      attempt: {
        try: [{ boom: { call: 'unsupported-kind' } }],
        catch: { as: 'err', do: [{ recovered: { set: { msg: '${ .var.err.message }' } } }] },
      },
    },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  const recovered = ctx.outputs.recovered as { msg: string };
  expect(recovered.msg).toMatch(/unsupported-kind is not supported/);
});

test('if: truthy condition runs the task and records output', async () => {
  const tasks = normalizeTaskList([
    { setup: { set: { go: true } } },
    { gated: { if: '${ .output.setup.go }', set: { ran: true } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.gated).toEqual({ ran: true });
});

test('if: falsy condition skips the task and records no output', async () => {
  const tasks = normalizeTaskList([
    { setup: { set: { go: false } } },
    { gated: { if: '${ .output.setup.go }', set: { ran: true } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.gated).toBeUndefined();
});

test('if: skipped task emits a task:skip event but no start/end', async () => {
  const tasks = normalizeTaskList([{ gated: { if: '${ false }', set: { ran: true } } }]);
  const ctx = new ExecutionContext({});
  const events: Array<{ kind: string; name: string }> = [];
  const engine = new Engine();
  engine.bus.on((e) => {
    if (e.kind === 'task:start' || e.kind === 'task:end' || e.kind === 'task:skip') {
      events.push({ kind: e.kind, name: e.path[e.path.length - 1] ?? '' });
    }
  });
  await engine.runTaskList(tasks, ctx);
  expect(events).toEqual([{ kind: 'task:skip', name: 'gated' }]);
});

test('if: applies inside a for-loop body (continue-like skip per iteration)', async () => {
  const tasks = normalizeTaskList([
    { acc: { set: { picked: [] } } },
    {
      loop: {
        for: { each: 'item', in: '${ .input.items }' },
        do: [
          {
            keep: {
              if: '${ .var.item % 2 == 0 }',
              set: { picked: '${ .output.acc.picked + [.var.item] }' },
            },
          },
          { acc: { set: { picked: '${ .output.keep.picked // .output.acc.picked }' } } },
        ],
      },
    },
  ]);
  const ctx = new ExecutionContext({ input: { items: [1, 2, 3, 4, 5] } });
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.acc).toEqual({ picked: [2, 4] });
});

test('if: applies to control-flow kinds (skips a `for` whose guard is false)', async () => {
  const tasks = normalizeTaskList([
    {
      loop: {
        if: '${ false }',
        for: { each: 'i', in: '${ [range(1; 4)] }' },
        do: [{ noop: { set: { x: '${ .var.i }' } } }],
      },
    },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.noop).toBeUndefined();
});

test('try/catch/retry: retries the try body until success', async () => {
  // Install a temporary `call: probe` handler that throws until attempts >= 3
  // by overriding the `call` dispatcher for this test only.
  let attempts = 0;
  const baseMod = await import('../../src/runners/base');
  const original = baseMod.snapshotRegistry();
  const callMod = await import('../../src/runners/call');
  const setMod = await import('../../src/runners/set');
  const runMod = await import('../../src/runners/run');
  baseMod.clearRegistry();
  baseMod.registerRunner('set', () => new setMod.SetRunner());
  baseMod.registerRunner('run', () => new runMod.RunDispatcher());
  baseMod.registerRunner('call', () => ({
    async run(_ctx, body) {
      if (body.call === 'probe') {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return { attempts };
      }
      return new callMod.CallDispatcher().run(_ctx, body);
    },
  }));
  try {
    const tasks = normalizeTaskList([
      {
        attempt: {
          try: [{ work: { call: 'probe' } }],
          catch: {
            retry: {
              delay: { seconds: 0 },
              limit: { attempt: { count: 5 } },
            },
          },
        },
      },
    ]);
    const ctx = new ExecutionContext({});
    await new Engine().runTaskList(tasks, ctx);
    expect(ctx.outputs.work).toEqual({ attempts: 3 });
  } finally {
    baseMod.clearRegistry();
    baseMod.registerRunner('set', () => new setMod.SetRunner());
    baseMod.registerRunner('call', () => new callMod.CallDispatcher());
    baseMod.registerRunner('run', () => new runMod.RunDispatcher());
    expect(baseMod.snapshotRegistry().sort()).toEqual(original.sort());
  }
});
