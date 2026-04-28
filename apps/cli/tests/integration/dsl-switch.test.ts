import { expect, test } from 'bun:test';
import { Engine } from '../../src/engine/executor';
import { loadWorkflow } from '../../src/io';

test.each([
  [35, 'hot_branch', 'hot', ['cold_branch', 'mild_branch']],
  [5, 'cold_branch', 'cold', ['hot_branch', 'mild_branch']],
  [20, 'mild_branch', 'mild', ['hot_branch', 'cold_branch']],
])('switch picks correct branch for temp=%i', async (temp, branch, expected, others) => {
  const wf = loadWorkflow('tests/fixtures/dsl-switch.yaml');
  const outputs = await new Engine().runWorkflow(wf, { input: { temp } });
  expect((outputs[branch] as Record<string, unknown>).picked).toBe(expected);
  for (const other of others as string[]) {
    expect(outputs[other]).toBeUndefined();
  }
});
