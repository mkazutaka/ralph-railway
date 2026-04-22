/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` is jq expression syntax */
import { expect, test } from 'bun:test';
import { ExecutionContext } from '../../src/engine/context';
import { EngineBus, type EngineEvent } from '../../src/engine/events';
import { Engine } from '../../src/engine/executor';
import { normalizeTaskList } from '../../src/engine/tasks';

function collect(bus: EngineBus): EngineEvent[] {
  const events: EngineEvent[] = [];
  bus.on((e) => events.push(e));
  return events;
}

test('emits task:start + task:end in order for two set tasks', async () => {
  const bus = new EngineBus();
  const events = collect(bus);
  const tasks = normalizeTaskList([
    { greet: { set: { msg: 'hi' } } },
    { finish: { set: { done: true } } },
  ]);
  await new Engine(bus).runTaskList(tasks, new ExecutionContext({}));

  const kinds = events.map((e) => e.kind);
  expect(kinds).toEqual(['task:start', 'task:end', 'task:start', 'task:end']);

  const starts = events.filter((e) => e.kind === 'task:start');
  expect(starts[0]?.path).toEqual(['greet']);
  expect(starts[1]?.path).toEqual(['finish']);

  const ends = events.filter((e) => e.kind === 'task:end');
  expect(ends[0]?.path).toEqual(['greet']);
  expect(ends[1]?.path).toEqual(['finish']);
  for (const e of ends) {
    if (e.kind === 'task:end') expect(typeof e.durationMs).toBe('number');
  }
});

test('for-loop emits iteration:start events with 0..n-1 indices', async () => {
  const bus = new EngineBus();
  const events = collect(bus);
  const tasks = normalizeTaskList([
    {
      loop: {
        for: { each: 'item', in: '${ .input.items }' },
        do: [{ tap: { set: { v: '${ .var.item }' } } }],
      },
    },
  ]);
  await new Engine(bus).runTaskList(
    tasks,
    new ExecutionContext({ input: { items: ['a', 'b', 'c'] } }),
  );

  const iterations = events.filter((e) => e.kind === 'iteration:start');
  expect(iterations).toHaveLength(3);
  expect(iterations.map((e) => (e.kind === 'iteration:start' ? e.index : -1))).toEqual([0, 1, 2]);
  expect(iterations.map((e) => (e.kind === 'iteration:start' ? e.total : -1))).toEqual([3, 3, 3]);
  for (const e of iterations) {
    expect(e.path).toEqual(['loop']);
  }
});

test('failing task emits task:error with message', async () => {
  const bus = new EngineBus();
  const events = collect(bus);
  const tasks = normalizeTaskList([{ boom: { call: 'no-such-kind' } }]);

  await expect(new Engine(bus).runTaskList(tasks, new ExecutionContext({}))).rejects.toThrow();

  const err = events.find((e) => e.kind === 'task:error');
  expect(err).toBeDefined();
  if (err && err.kind === 'task:error') {
    expect(err.path).toEqual(['boom']);
    expect(err.taskKind).toBe('call');
    expect(err.message).toMatch(/no-such-kind/);
  }
});
