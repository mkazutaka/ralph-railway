import { expect, test } from 'bun:test';
import type { EngineEvent } from '../../src/engine/events';
import { EngineStore, type LogEntry } from '../../src/ui/hooks/useEngineState';

interface Recorded {
  store: EngineStore;
  written: LogEntry[][];
}

function makeStore(): Recorded {
  const written: LogEntry[][] = [];
  const store = new EngineStore(0);
  store.setStdOutWrite((entries) => {
    written.push(entries);
  });
  return { store, written };
}

function dispatch(rec: Recorded, events: EngineEvent[]): void {
  for (const e of events) rec.store.dispatch(e);
}

function kinds(written: LogEntry[][]): string[] {
  return written.flat().map((e) => e.kind);
}

test('task:start writes task-start row and pushes onto runningTasks', () => {
  const rec = makeStore();
  dispatch(rec, [{ kind: 'task:start', path: ['a'], taskKind: 'set', taskId: 't1' }]);
  expect(kinds(rec.written)).toEqual(['task-start']);
  expect(rec.store.state.runningTasks).toHaveLength(1);
  expect(rec.store.state.runningTasks[0]?.name).toBe('a');
  expect(rec.store.state.totalTasks).toBe(1);
});

test('task:end writes task-end row and removes the task from runningTasks', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['a'], taskKind: 'call', taskId: 't1' },
    {
      kind: 'task:end',
      path: ['a'],
      taskKind: 'call',
      taskId: 't1',
      durationMs: 0,
      output: { totalCostUsd: 0.012, toolsUsed: ['Bash', 'Read', 'Read'] },
    },
  ]);
  expect(kinds(rec.written)).toEqual(['task-start', 'task-end']);
  expect(rec.store.state.runningTasks).toHaveLength(0);
  expect(rec.store.state.completedTasks).toBe(1);
  expect(rec.store.state.costUsd).toBeCloseTo(0.012, 5);
  const end = rec.written[1]?.[0];
  if (end?.kind === 'task-end') {
    expect(end.toolsCount).toBe(3);
  }
});

test('task:error removes the task from runningTasks and writes task-error', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['x'], taskKind: 'call', taskId: 'x1' },
    {
      kind: 'task:error',
      path: ['x'],
      taskKind: 'call',
      taskId: 'x1',
      message: 'boom',
    },
  ]);
  expect(kinds(rec.written)).toEqual(['task-start', 'task-error']);
  expect(rec.store.state.runningTasks).toHaveLength(0);
  expect(rec.store.state.erroredTasks).toBe(1);
});

test('task:skip writes a one-shot task-skip row without changing runningTasks', () => {
  const rec = makeStore();
  dispatch(rec, [{ kind: 'task:skip', path: ['gated'], taskKind: 'set', taskId: 's1' }]);
  expect(kinds(rec.written)).toEqual(['task-skip']);
  expect(rec.store.state.runningTasks).toHaveLength(0);
  expect(rec.store.state.totalTasks).toBe(0);
});

test('iteration:start writes a row; iteration:end is silent (no row)', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['loop'], taskKind: 'for', taskId: 'L1' },
    { kind: 'iteration:start', path: ['loop'], taskId: 'L1', index: 0, total: 3 },
    { kind: 'iteration:end', path: ['loop'], taskId: 'L1', index: 0, total: 3 },
  ]);
  expect(kinds(rec.written)).toEqual(['task-start', 'iteration']);
});

test('claude:text chunks coalesce, then flush on tool_use boundary', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['ask'], taskKind: 'call', taskId: 'a1' },
    { kind: 'claude:text', path: ['ask'], taskId: 'a1', text: 'hello ' },
    { kind: 'claude:text', path: ['ask'], taskId: 'a1', text: 'world' },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      taskId: 'a1',
      activityId: 't1',
      name: 'Bash',
      input: { command: 'ls' },
    },
  ]);
  // task-start, then coalesced text on tool_use boundary; tool-use stays in
  // activities (no result yet) so isn't written.
  expect(kinds(rec.written)).toEqual(['task-start', 'text']);
  const txt = rec.written[1]?.[0];
  if (txt?.kind === 'text') expect(txt.text).toBe('hello world');
  const tools = rec.store.state.runningTasks[0]?.runningActivities.filter((a) => a.kind === 'tool');
  expect(tools).toHaveLength(1);
});

test('non-Read tool: tool-use+result pair writes together when result arrives', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['ask'], taskKind: 'call', taskId: 'a1' },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      taskId: 'a1',
      activityId: 't1',
      name: 'Bash',
      input: { command: 'ls' },
    },
    {
      kind: 'claude:tool_result',
      path: ['ask'],
      taskId: 'a1',
      activityId: 't1',
      content: 'ok',
      isError: false,
    },
  ]);
  // task-start was written immediately. tool-use stayed in activities
  // until result arrived; the pair was then written together.
  expect(kinds(rec.written)).toEqual(['task-start', 'tool-use', 'tool-result']);
  const tools = rec.store.state.runningTasks[0]?.runningActivities.filter((a) => a.kind === 'tool');
  expect(tools).toHaveLength(0);
});

test('Read tool grouping: consecutive Reads buffer until a non-Read terminator', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['ask'], taskKind: 'call', taskId: 'a1' },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'r1',
      name: 'Read',
      input: { file_path: 'a' },
    },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'r2',
      name: 'Read',
      input: { file_path: 'b' },
    },
    {
      kind: 'claude:tool_result',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'r1',
      content: 'a',
      isError: false,
    },
    {
      kind: 'claude:tool_result',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'r2',
      content: 'b',
      isError: false,
    },
    // Terminator: a non-Read tool-use flushes the Read group.
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'b1',
      name: 'Bash',
      input: { command: 'ls' },
    },
  ]);
  // task-start, then the Read group flushed as a single chunk
  // ([r1-use, r2-use, r1-result, r2-result]).
  expect(rec.written).toHaveLength(2);
  const groupChunk = rec.written[1];
  expect(groupChunk?.filter((e) => e.kind === 'tool-use')).toHaveLength(2);
  expect(groupChunk?.filter((e) => e.kind === 'tool-result')).toHaveLength(2);
});

test('Read group flushes at claude:end if no terminator arrived', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['ask'], taskKind: 'call', taskId: 'a1' },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'r1',
      name: 'Read',
      input: { file_path: 'a' },
    },
    {
      kind: 'claude:tool_result',
      path: ['ask'],
      taskId: 'a1',
      activityId: 'r1',
      content: 'a',
      isError: false,
    },
    { kind: 'claude:end', path: ['ask'], taskId: 'a1' },
    { kind: 'task:end', path: ['ask'], taskKind: 'call', taskId: 'a1', durationMs: 0 },
  ]);
  // Read group flushed at claude:end as a chunk of [use, result], then task-end.
  expect(kinds(rec.written)).toEqual(['task-start', 'tool-use', 'tool-result', 'task-end']);
});

test('shell:stdout/stderr coalesce per-stream and flush on cross-stream switch + shell:end', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['sh'], taskKind: 'run', taskId: 's1' },
    { kind: 'shell:stdout', path: ['sh'], taskId: 's1', chunk: 'line1\n' },
    { kind: 'shell:stdout', path: ['sh'], taskId: 's1', chunk: 'line2\n' },
    { kind: 'shell:stderr', path: ['sh'], taskId: 's1', chunk: 'warn\n' },
    { kind: 'shell:end', path: ['sh'], taskId: 's1' },
    { kind: 'task:end', path: ['sh'], taskKind: 'run', taskId: 's1', durationMs: 0 },
  ]);
  expect(kinds(rec.written)).toEqual(['task-start', 'shell-stdout', 'shell-stderr', 'task-end']);
});

test('costUsd accumulates totalCostUsd from each task:end', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['a'], taskKind: 'call', taskId: 'a1' },
    {
      kind: 'task:end',
      path: ['a'],
      taskKind: 'call',
      taskId: 'a1',
      durationMs: 0,
      output: { totalCostUsd: 0.03 },
    },
    { kind: 'task:start', path: ['b'], taskKind: 'call', taskId: 'b1' },
    {
      kind: 'task:end',
      path: ['b'],
      taskKind: 'call',
      taskId: 'b1',
      durationMs: 0,
      output: { totalCostUsd: 0.07 },
    },
  ]);
  expect(rec.store.state.costUsd).toBeCloseTo(0.1, 5);
});

test('claude:end finalizes pending text/Read group/orphan tools without task:end', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['ask'], taskKind: 'call', taskId: 'a1' },
    { kind: 'claude:text', path: ['ask'], taskId: 'a1', text: 'hello' },
    { kind: 'claude:end', path: ['ask'], taskId: 'a1' },
  ]);
  // claude:end finalizes — text is now in scrollback even though task is open.
  expect(kinds(rec.written)).toEqual(['task-start', 'text']);
  const task = rec.store.state.taskMap.get('a1');
  expect(task?.runningActivities).toHaveLength(0);
});

test('shell:end finalizes pending shell buffers', () => {
  const rec = makeStore();
  dispatch(rec, [
    { kind: 'task:start', path: ['sh'], taskKind: 'run', taskId: 's1' },
    { kind: 'shell:stdout', path: ['sh'], taskId: 's1', chunk: 'hi' },
    { kind: 'shell:end', path: ['sh'], taskId: 's1' },
  ]);
  expect(kinds(rec.written)).toEqual(['task-start', 'shell-stdout']);
});

test('events for an unknown task instance are ignored or written as orphans', () => {
  const rec = makeStore();
  dispatch(rec, [{ kind: 'shell:stdout', path: ['sh'], taskId: 'gone', chunk: 'x' }]);
  expect(rec.written).toHaveLength(0);
  expect(rec.store.state.runningTasks).toHaveLength(0);
});
