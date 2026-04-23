// tests/unit/ui-state.test.ts
import { expect, test } from 'bun:test';
import type { EngineEvent } from '../../src/engine/events';
import { initialState, type LogEntry, reducer, type State } from '../../src/ui/useEngineState';

function apply(state: State, events: EngineEvent[]): State {
  return events.reduce<State>((s, e) => reducer(s, e), state);
}

function kinds(entries: LogEntry[]): string[] {
  return entries.map((e) => e.kind);
}

test('task:skip appends a "task-skip" entry without touching runningPaths/totalTasks', () => {
  const s = apply(initialState(0), [{ kind: 'task:skip', path: ['gated'], taskKind: 'set' }]);
  expect(s.logEntries).toHaveLength(1);
  const e = s.logEntries[0];
  expect(e?.kind).toBe('task-skip');
  if (e?.kind === 'task-skip') {
    expect(e.name).toBe('gated');
    expect(e.depth).toBe(0);
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.totalTasks).toBe(0);
});

test('task:start appends a "task-start" entry with depth and tracks runningPaths', () => {
  const s = apply(initialState(0), [{ kind: 'task:start', path: ['a'], taskKind: 'set' }]);
  expect(s.logEntries).toHaveLength(1);
  const e = s.logEntries[0];
  expect(e?.kind).toBe('task-start');
  if (e?.kind === 'task-start') {
    expect(e.name).toBe('a');
    expect(e.depth).toBe(0);
    expect(e.taskKind).toBe('set');
  }
  expect(s.runningPaths).toEqual(['a']);
  expect(s.totalTasks).toBe(1);
});

test('task:start strips #N suffix from name', () => {
  const s = apply(initialState(0), [{ kind: 'task:start', path: ['greet#2'], taskKind: 'call' }]);
  const e = s.logEntries[0];
  if (e?.kind === 'task-start') expect(e.name).toBe('greet');
});

test('task:end appends a "task-end" entry with duration/cost/tools and removes from runningPaths', () => {
  const s = apply(initialState(1000), [
    { kind: 'task:start', path: ['a'], taskKind: 'call' },
    {
      kind: 'task:end',
      path: ['a'],
      taskKind: 'call',
      durationMs: 0,
      output: { totalCostUsd: 0.012, toolsUsed: ['Bash', 'Read', 'Read'] },
    },
  ]);
  expect(kinds(s.logEntries)).toEqual(['task-start', 'task-end']);
  const end = s.logEntries[1];
  if (end?.kind === 'task-end') {
    expect(end.name).toBe('a');
    expect(end.depth).toBe(0);
    expect(end.costUsd).toBeCloseTo(0.012, 5);
    expect(end.toolsCount).toBe(3);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.costUsd).toBeCloseTo(0.012, 5);
});

test('task:error appends a "task-error" entry with full message and removes from runningPaths', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['x'], taskKind: 'call' },
    { kind: 'task:error', path: ['x'], taskKind: 'call', message: 'line one\nline two' },
  ]);
  const last = s.logEntries[s.logEntries.length - 1];
  expect(last?.kind).toBe('task-error');
  if (last?.kind === 'task-error') {
    expect(last.name).toBe('x');
    expect(last.message).toBe('line one\nline two');
  }
  expect(s.runningPaths).toEqual([]);
});

test('iteration:start appends an "iteration" entry with 1-indexed display values', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['loop'], taskKind: 'for' },
    { kind: 'iteration:start', path: ['loop'], index: 0, total: 3 },
    { kind: 'iteration:start', path: ['loop'], index: 1, total: 3 },
  ]);
  const it = s.logEntries.filter((e) => e.kind === 'iteration');
  expect(it).toHaveLength(2);
  if (it[0]?.kind === 'iteration') {
    expect(it[0].displayIndex).toBe(1);
    expect(it[0].total).toBe(3);
  }
});

test('consecutive claude:text chunks coalesce into a single text entry', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:text', path: ['ask'], text: 'hello ' },
    { kind: 'claude:text', path: ['ask'], text: 'world' },
    { kind: 'task:end', path: ['ask'], taskKind: 'call', durationMs: 0 },
  ]);
  const text = s.logEntries.find((e) => e.kind === 'text');
  expect(text?.kind).toBe('text');
  if (text?.kind === 'text') expect(text.text).toBe('hello world');
});

test('claude:text buffer flushes on tool_use boundary, in order', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:text', path: ['ask'], text: 'first ' },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      toolUseId: 't1',
      name: 'Bash',
      input: { command: 'ls' },
    },
    { kind: 'claude:text', path: ['ask'], text: 'second' },
    { kind: 'task:end', path: ['ask'], taskKind: 'call', durationMs: 0 },
  ]);
  expect(kinds(s.logEntries)).toEqual(['task-start', 'text', 'tool-use', 'text', 'task-end']);
  const firstText = s.logEntries[1];
  if (firstText?.kind === 'text') expect(firstText.text).toBe('first ');
});

test('claude:thinking chunks coalesce and flush like text', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:thinking', path: ['ask'], text: 'hmm' },
    { kind: 'claude:thinking', path: ['ask'], text: '... still' },
    { kind: 'claude:text', path: ['ask'], text: 'answer' },
    { kind: 'task:end', path: ['ask'], taskKind: 'call', durationMs: 0 },
  ]);
  expect(kinds(s.logEntries)).toEqual(['task-start', 'thinking', 'text', 'task-end']);
  const th = s.logEntries[1];
  if (th?.kind === 'thinking') expect(th.text).toBe('hmm... still');
});

test('claude:tool_use appends a "tool-use" entry; matching tool_result appends a "tool-result"', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    {
      kind: 'claude:tool_use',
      path: ['ask'],
      toolUseId: 't1',
      name: 'Bash',
      input: { command: 'echo hi' },
    },
    {
      kind: 'claude:tool_result',
      path: ['ask'],
      toolUseId: 't1',
      content: 'hi\n',
      isError: false,
    },
  ]);
  expect(kinds(s.logEntries)).toEqual(['task-start', 'tool-use', 'tool-result']);
  const tu = s.logEntries[1];
  const tr = s.logEntries[2];
  if (tu?.kind === 'tool-use') {
    expect(tu.name).toBe('Bash');
    expect(tu.input).toEqual({ command: 'echo hi' });
    expect(tu.depth).toBe(0);
  }
  if (tr?.kind === 'tool-result') {
    expect(tr.name).toBe('Bash');
    expect(tr.content).toBe('hi\n');
    expect(tr.isError).toBe(false);
    expect(tr.depth).toBe(0);
  }
});

test('orphan tool_result (no prior tool_use) renders with name "?"', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    {
      kind: 'claude:tool_result',
      path: ['ask'],
      toolUseId: 'orphan',
      content: 'whoops',
      isError: true,
    },
  ]);
  const last = s.logEntries[s.logEntries.length - 1];
  if (last?.kind === 'tool-result') {
    expect(last.name).toBe('?');
    expect(last.isError).toBe(true);
  }
});

test('depth reflects path length minus 1', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['loop'], taskKind: 'for' },
    { kind: 'task:start', path: ['loop', 'step'], taskKind: 'set' },
    { kind: 'task:end', path: ['loop', 'step'], taskKind: 'set', durationMs: 0 },
  ]);
  const starts = s.logEntries.filter((e) => e.kind === 'task-start');
  if (starts[0]?.kind === 'task-start') expect(starts[0].depth).toBe(0);
  if (starts[1]?.kind === 'task-start') expect(starts[1].depth).toBe(1);
});

test('runningPaths preserves insertion order and removes finished tasks', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['a'], taskKind: 'call' },
    { kind: 'task:start', path: ['b'], taskKind: 'call' },
    { kind: 'task:start', path: ['c'], taskKind: 'call' },
    { kind: 'task:end', path: ['b'], taskKind: 'call', durationMs: 0 },
  ]);
  expect(s.runningPaths).toEqual(['a', 'c']);
});

test('task:end flushes any pending text buffered before it', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:text', path: ['ask'], text: 'hello' },
    { kind: 'task:end', path: ['ask'], taskKind: 'call', durationMs: 0 },
  ]);
  expect(kinds(s.logEntries)).toEqual(['task-start', 'text', 'task-end']);
});

test('task:error flushes any pending text buffered before it', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:thinking', path: ['ask'], text: 'pondering...' },
    { kind: 'task:error', path: ['ask'], taskKind: 'call', message: 'boom' },
  ]);
  expect(kinds(s.logEntries)).toEqual(['task-start', 'thinking', 'task-error']);
});

test('costUsd accumulates totalCostUsd from each task:end', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['a'], taskKind: 'call' },
    {
      kind: 'task:end',
      path: ['a'],
      taskKind: 'call',
      durationMs: 0,
      output: { totalCostUsd: 0.03 },
    },
    { kind: 'task:start', path: ['b'], taskKind: 'call' },
    {
      kind: 'task:end',
      path: ['b'],
      taskKind: 'call',
      durationMs: 0,
      output: { totalCostUsd: 0.07 },
    },
  ]);
  expect(s.costUsd).toBeCloseTo(0.1, 5);
});

test('task:start re-entry flushes any buffered text from the prior run', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['loop', 'body'], taskKind: 'call' },
    { kind: 'claude:text', path: ['loop', 'body'], text: 'half-said' },
    // Re-entry without an intervening task:end — should NOT lose 'half-said'.
    { kind: 'task:start', path: ['loop', 'body'], taskKind: 'call' },
  ]);
  // Expected: task-start, text (flushed), task-start (re-entry).
  expect(s.logEntries.map((e) => e.kind)).toEqual(['task-start', 'text', 'task-start']);
  const text = s.logEntries[1];
  if (text?.kind === 'text') expect(text.text).toBe('half-said');
});
