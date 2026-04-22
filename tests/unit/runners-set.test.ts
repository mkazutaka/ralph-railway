/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { SetRunner } from '../../src/runners/set';

test('set evaluates string interpolation', async () => {
  const ctx = new ExecutionContext({ input: { name: 'world' } });
  const out = await new SetRunner().run(ctx, {
    set: { greeting: 'hello ${ .input.name }' },
  });
  expect(out).toEqual({ greeting: 'hello world' });
});

test('set evaluates pure expression and preserves type', async () => {
  const ctx = new ExecutionContext({ input: { n: 7 } });
  const out = await new SetRunner().run(ctx, {
    set: { count: '${ .input.n }' },
  });
  expect(out).toEqual({ count: 7 });
});

test('set recurses through nested objects and arrays', async () => {
  const ctx = new ExecutionContext({ input: { x: 'X' } });
  const out = await new SetRunner().run(ctx, {
    set: {
      nested: { a: '${ .input.x }', b: ['plain', '${ .input.x }'] },
    },
  });
  expect(out).toEqual({ nested: { a: 'X', b: ['plain', 'X'] } });
});

test('set passes non-string values through unchanged', async () => {
  const ctx = new ExecutionContext({});
  const out = await new SetRunner().run(ctx, {
    set: { n: 42, b: true, nil: null },
  });
  expect(out).toEqual({ n: 42, b: true, nil: null });
});

test('set with empty body returns empty object', async () => {
  const ctx = new ExecutionContext({});
  const out = await new SetRunner().run(ctx, {});
  expect(out).toEqual({});
});
