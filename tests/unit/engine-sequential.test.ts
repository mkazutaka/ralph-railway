/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { Engine } from '../../src/engine/executor';
import { normalizeTaskList } from '../../src/engine/tasks';

test('runs two set tasks in order', async () => {
  const tasks = normalizeTaskList([
    { first: { set: { a: 1 } } },
    { second: { set: { b: '${ .output.first.a }' } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs).toEqual({ first: { a: 1 }, second: { b: 1 } });
});

test('do task runs nested task list', async () => {
  const tasks = normalizeTaskList([
    {
      group: {
        do: [{ inner: { set: { v: 'x' } } }],
      },
    },
    { after: { set: { last: '${ .output.inner.v }' } } },
  ]);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.inner).toEqual({ v: 'x' });
  expect(ctx.outputs.after).toEqual({ last: 'x' });
});
