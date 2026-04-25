import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test.each([
  [35, 'hot_branch', 'hot'],
  [5, 'cold_branch', 'cold'],
  [20, 'mild_branch', 'mild'],
])('switch picks correct branch for temp=%i', async (temp, branch, expected) => {
  const wf = loadWorkflow('tests/fixtures/dsl-switch.yaml');
  const outputs = await new Engine().runWorkflow(wf, { input: { temp } });
  expect((outputs[branch] as Record<string, unknown>).picked).toBe(expected);
});
