// tests/unit/ui-state.test.ts
import { expect, test } from 'bun:test';
import type { EngineEvent } from '../../src/engine/events';
import { splitAtLiveBoundary } from '../../src/ui/renderItems';
import {
  EngineStore,
  initialState,
  type LogEntry,
  reducer,
  type State,
} from '../../src/ui/useEngineState';

function apply(state: State, events: EngineEvent[]): State {
  return events.reduce<State>((s, e) => reducer(s, e), state);
}

function kinds(entries: LogEntry[]): string[] {
  return entries.map((e) => e.kind);
}

/**
 * Group `state.pending` into the entries belonging to the task identified by
 * `key` (a `>`-joined path). The flat-pending refactor dropped the old
 * `liveTasks` map, so this helper recreates the per-task slice tests assert
 * against by filtering on the depth implied by the key's path length. Tests
 * use unique task names per depth, so depth alone disambiguates here.
 */
function taskEntries(state: State, key: string): LogEntry[] {
  const depth = Math.max(0, key.split('>').length - 1);
  return state.pending.filter((e) => e.depth === depth);
}

test('task:skip creates a one-shot live entry without touching runningPaths/totalTasks', () => {
  const s = apply(initialState(0), [{ kind: 'task:skip', path: ['gated'], taskKind: 'set' }]);
  const entries = taskEntries(s, 'gated');
  expect(kinds(entries)).toEqual(['task-skip']);
  const e = entries[0];
  if (e?.kind === 'task-skip') {
    expect(e.name).toBe('gated');
    expect(e.depth).toBe(0);
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.totalTasks).toBe(0);
});

test('task:start opens a task with depth and tracks runningPaths', () => {
  const s = apply(initialState(0), [{ kind: 'task:start', path: ['a'], taskKind: 'set' }]);
  const entries = taskEntries(s, 'a');
  expect(kinds(entries)).toEqual(['task-start']);
  const e = entries[0];
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
  const entries = taskEntries(s, 'greet#2');
  const e = entries[0];
  if (e?.kind === 'task-start') expect(e.name).toBe('greet');
});

test('task:end appends task-end with duration/cost/tools and removes from runningPaths', () => {
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
  const entries = taskEntries(s, 'a');
  expect(kinds(entries)).toEqual(['task-start', 'task-end']);
  const end = entries[1];
  if (end?.kind === 'task-end') {
    expect(end.name).toBe('a');
    expect(end.depth).toBe(0);
    expect(end.costUsd).toBeCloseTo(0.012, 5);
    expect(end.toolsCount).toBe(3);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.costUsd).toBeCloseTo(0.012, 5);
  expect(s.completedTasks).toBe(1);
});

test('task:error appends task-error with full message and removes from runningPaths', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['x'], taskKind: 'call' },
    { kind: 'task:error', path: ['x'], taskKind: 'call', message: 'line one\nline two' },
  ]);
  const entries = taskEntries(s, 'x');
  const last = entries[entries.length - 1];
  expect(last?.kind).toBe('task-error');
  if (last?.kind === 'task-error') {
    expect(last.name).toBe('x');
    expect(last.message).toBe('line one\nline two');
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.erroredTasks).toBe(1);
});

test('completed task entries are committable via splitAtLiveBoundary', () => {
  const store = new EngineStore(0);
  store.dispatch({ kind: 'task:start', path: ['ok'], taskKind: 'set' });
  store.dispatch({ kind: 'task:end', path: ['ok'], taskKind: 'set', durationMs: 0 });

  const before = store.state.revision;
  const { commitEntryCount } = splitAtLiveBoundary(store.state.pending);

  expect(commitEntryCount).toBe(2);
  expect(before).toBeGreaterThan(0);
  expect(store.state.completedTasks).toBe(1);
  expect(store.state.totalTasks).toBe(1);

  // Mirror App.tsx's commit step so the next split sees an empty buffer.
  store.state.pending.splice(0, commitEntryCount);
  expect(splitAtLiveBoundary(store.state.pending).commitEntryCount).toBe(0);
});

test('iteration:start appends an "iteration" entry with 1-indexed display values', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['loop'], taskKind: 'for' },
    { kind: 'iteration:start', path: ['loop'], index: 0, total: 3 },
    { kind: 'iteration:start', path: ['loop'], index: 1, total: 3 },
  ]);
  const entries = taskEntries(s, 'loop');
  const it = entries.filter((e) => e.kind === 'iteration');
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
  const entries = taskEntries(s, 'ask');
  const text = entries.find((e) => e.kind === 'text');
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
  const entries = taskEntries(s, 'ask');
  expect(kinds(entries)).toEqual(['task-start', 'text', 'tool-use', 'text', 'task-end']);
  const firstText = entries[1];
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
  const entries = taskEntries(s, 'ask');
  expect(kinds(entries)).toEqual(['task-start', 'thinking', 'text', 'task-end']);
  const th = entries[1];
  if (th?.kind === 'thinking') expect(th.text).toBe('hmm... still');
});

test('claude:tool_use appends tool-use; matching tool_result appends tool-result', () => {
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
  const entries = taskEntries(s, 'ask');
  expect(kinds(entries)).toEqual(['task-start', 'tool-use', 'tool-result']);
  const tu = entries[1];
  const tr = entries[2];
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
  const entries = taskEntries(s, 'ask');
  const last = entries[entries.length - 1];
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
  const outer = taskEntries(s, 'loop');
  const inner = taskEntries(s, 'loop>step');
  const outerStart = outer[0];
  const innerStart = inner[0];
  if (outerStart?.kind === 'task-start') expect(outerStart.depth).toBe(0);
  if (innerStart?.kind === 'task-start') expect(innerStart.depth).toBe(1);
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
  const entries = taskEntries(s, 'ask');
  expect(kinds(entries)).toEqual(['task-start', 'text', 'task-end']);
});

test('task:error flushes any pending text buffered before it', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:thinking', path: ['ask'], text: 'pondering...' },
    { kind: 'task:error', path: ['ask'], taskKind: 'call', message: 'boom' },
  ]);
  const entries = taskEntries(s, 'ask');
  expect(kinds(entries)).toEqual(['task-start', 'thinking', 'task-error']);
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
  const entries = taskEntries(s, 'loop>body');
  expect(kinds(entries)).toEqual(['task-start', 'text', 'task-start']);
  const text = entries[1];
  if (text?.kind === 'text') expect(text.text).toBe('half-said');
});

test('consecutive shell:stdout chunks coalesce into a single shell-stdout entry', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['sh'], taskKind: 'run' },
    { kind: 'shell:stdout', path: ['sh'], chunk: 'line1\n' },
    { kind: 'shell:stdout', path: ['sh'], chunk: 'line2\n' },
    { kind: 'task:end', path: ['sh'], taskKind: 'run', durationMs: 0 },
  ]);
  const entries = taskEntries(s, 'sh');
  expect(kinds(entries)).toEqual(['task-start', 'shell-stdout', 'task-end']);
  const out = entries[1];
  if (out?.kind === 'shell-stdout') expect(out.text).toBe('line1\nline2\n');
});

test('shell:stdout and shell:stderr interleave by flushing each other', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['sh'], taskKind: 'run' },
    { kind: 'shell:stdout', path: ['sh'], chunk: 'hello\n' },
    { kind: 'shell:stderr', path: ['sh'], chunk: 'warn\n' },
    { kind: 'shell:stdout', path: ['sh'], chunk: 'bye\n' },
    { kind: 'task:end', path: ['sh'], taskKind: 'run', durationMs: 0 },
  ]);
  const entries = taskEntries(s, 'sh');
  expect(kinds(entries)).toEqual([
    'task-start',
    'shell-stdout',
    'shell-stderr',
    'shell-stdout',
    'task-end',
  ]);
});

test('shell:stdout events arriving without an active task are ignored', () => {
  const s = apply(initialState(0), [{ kind: 'shell:stdout', path: ['sh'], chunk: 'x' }]);
  expect(s.pending).toHaveLength(0);
  expect(s.pendingByPath.size).toBe(0);
});
