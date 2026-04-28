import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { ExecutionContext } from '../../src/engine/context';
import { Engine } from '../../src/engine/executor';
import { normalizeTaskList } from '../../src/engine/tasks';

// The SLW SDK schema requires fork.branches to be a flat taskList, but the
// executor interprets branches as an array-of-arrays (each branch is a list
// of tasks). We load the fixture raw (bypassing SDK validation) so the
// array-of-arrays structure reaches the executor unchanged.
test('fork runs branches in parallel and merges outputs', async () => {
  const raw = yamlLoad(readFileSync('tests/fixtures/dsl-fork.yaml', 'utf-8')) as any;
  const tasks = normalizeTaskList(raw.do);
  const ctx = new ExecutionContext({});
  await new Engine().runTaskList(tasks, ctx);
  expect(ctx.outputs.left).toEqual({ side: 'L' });
  expect(ctx.outputs.right).toEqual({ side: 'R' });
});
