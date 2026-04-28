/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext, mergeBranchOutputs } from '../../src/engine/context';

test('evalStr reads .input', async () => {
  const ctx = new ExecutionContext({ input: { x: 10 } });
  expect(await ctx.evalStr('${ .input.x }')).toBe(10);
});

test('evalStr reads .output from recorded task outputs', async () => {
  const ctx = new ExecutionContext({});
  ctx.recordOutput('first', { a: 1 });
  expect(await ctx.evalStr('${ .output.first.a }')).toBe(1);
});

test('evalStr reads .var from var scope', async () => {
  const ctx = new ExecutionContext({});
  ctx.varScope.bind('name', 'Mei');
  expect(await ctx.evalStr('hello ${ .var.name }')).toBe('hello Mei');
});

test('evalValue recurses into objects and arrays', async () => {
  const ctx = new ExecutionContext({ input: { n: 3 } });
  const out = await ctx.evalValue({
    count: '${ .input.n }',
    items: ['${ .input.n }', 'plain', { nested: '${ .input.n }' }],
    untouched: 42,
  });
  expect(out).toEqual({
    count: 3,
    items: [3, 'plain', { nested: 3 }],
    untouched: 42,
  });
});

test('iterScope shares outputs with parent but has child varScope', async () => {
  const parent = new ExecutionContext({});
  parent.recordOutput('k', 'v');
  const iter = parent.iterScope();
  iter.varScope.bind('i', 5);
  expect(iter.outputs).toBe(parent.outputs);
  expect(await iter.evalStr('${ .var.i }')).toBe(5);
  expect(parent.varScope.has('i')).toBe(false);
  iter.recordOutput('newKey', 1);
  expect(parent.outputs.newKey).toBe(1);
});

test('forkScope isolates outputs', () => {
  const parent = new ExecutionContext({});
  parent.recordOutput('shared', 'parent-value');
  const fork = parent.forkScope();
  expect(fork.outputs).not.toBe(parent.outputs);
  fork.recordOutput('branch', 1);
  expect(parent.outputs.branch).toBeUndefined();
});

test('mergeBranchOutputs: single branch -> scalar', () => {
  const parent = new ExecutionContext({});
  mergeBranchOutputs(parent, [{ a: 1 }]);
  expect(parent.outputs).toEqual({ a: 1 });
});

test('mergeBranchOutputs: same-name collisions merge to array', () => {
  const parent = new ExecutionContext({});
  mergeBranchOutputs(parent, [{ a: 1 }, { a: 2, b: 3 }]);
  expect(parent.outputs).toEqual({ a: [1, 2], b: 3 });
});
