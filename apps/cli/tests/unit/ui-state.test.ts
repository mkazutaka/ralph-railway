// tests/unit/ui-state.test.ts
import { expect, test } from 'bun:test';
import type { EngineEvent } from '../../src/engine/events';
import {
  EngineStore,
  initialState,
  type LiveTask,
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

function task(state: State, key: string): LiveTask {
  const t = state.liveTasks.get(key);
  if (!t) throw new Error(`expected liveTask "${key}" to exist`);
  return t;
}

test('task:skip creates a one-shot live task without touching runningPaths/totalTasks', () => {
  const s = apply(initialState(0), [{ kind: 'task:skip', path: ['gated'], taskKind: 'set' }]);
  const t = task(s, 'gated');
  expect(kinds(t.entries)).toEqual(['task-skip']);
  const e = t.entries[0];
  if (e?.kind === 'task-skip') {
    expect(e.name).toBe('gated');
    expect(e.depth).toBe(0);
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.totalTasks).toBe(0);
});

test('task:start opens a live task with depth and tracks runningPaths', () => {
  const s = apply(initialState(0), [{ kind: 'task:start', path: ['a'], taskKind: 'set' }]);
  const t = task(s, 'a');
  expect(kinds(t.entries)).toEqual(['task-start']);
  const e = t.entries[0];
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
  const t = task(s, 'greet#2');
  const e = t.entries[0];
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
  const t = task(s, 'a');
  expect(kinds(t.entries)).toEqual(['task-start', 'task-end']);
  const end = t.entries[1];
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
  const t = task(s, 'x');
  const last = t.entries[t.entries.length - 1];
  expect(last?.kind).toBe('task-error');
  if (last?.kind === 'task-error') {
    expect(last.name).toBe('x');
    expect(last.message).toBe('line one\nline two');
  }
  expect(s.runningPaths).toEqual([]);
  expect(s.erroredTasks).toBe(1);
});

test('EngineStore.commit removes a task from liveTasks and bumps revision', () => {
  const store = new EngineStore(0);
  store.dispatch({ kind: 'task:start', path: ['ok'], taskKind: 'set' });
  store.dispatch({ kind: 'task:end', path: ['ok'], taskKind: 'set', durationMs: 0 });

  expect(store.state.liveTasks.has('ok')).toBe(true);
  const before = store.state.revision;

  store.commit('ok');

  expect(store.state.liveTasks.has('ok')).toBe(false);
  expect(store.state.revision).toBeGreaterThan(before);
  expect(store.state.completedTasks).toBe(1);
  expect(store.state.totalTasks).toBe(1);
});

test('iteration:start appends an "iteration" entry with 1-indexed display values', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['loop'], taskKind: 'for' },
    { kind: 'iteration:start', path: ['loop'], index: 0, total: 3 },
    { kind: 'iteration:start', path: ['loop'], index: 1, total: 3 },
  ]);
  const t = task(s, 'loop');
  const it = t.entries.filter((e) => e.kind === 'iteration');
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
  const t = task(s, 'ask');
  const text = t.entries.find((e) => e.kind === 'text');
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
  const t = task(s, 'ask');
  expect(kinds(t.entries)).toEqual(['task-start', 'text', 'tool-use', 'text', 'task-end']);
  const firstText = t.entries[1];
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
  const t = task(s, 'ask');
  expect(kinds(t.entries)).toEqual(['task-start', 'thinking', 'text', 'task-end']);
  const th = t.entries[1];
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
  const t = task(s, 'ask');
  expect(kinds(t.entries)).toEqual(['task-start', 'tool-use', 'tool-result']);
  const tu = t.entries[1];
  const tr = t.entries[2];
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
  const t = task(s, 'ask');
  const last = t.entries[t.entries.length - 1];
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
  const outer = task(s, 'loop');
  const inner = task(s, 'loop>step');
  const outerStart = outer.entries[0];
  const innerStart = inner.entries[0];
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
  const t = task(s, 'ask');
  expect(kinds(t.entries)).toEqual(['task-start', 'text', 'task-end']);
});

test('task:error flushes any pending text buffered before it', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['ask'], taskKind: 'call' },
    { kind: 'claude:thinking', path: ['ask'], text: 'pondering...' },
    { kind: 'task:error', path: ['ask'], taskKind: 'call', message: 'boom' },
  ]);
  const t = task(s, 'ask');
  expect(kinds(t.entries)).toEqual(['task-start', 'thinking', 'task-error']);
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
  const t = task(s, 'loop>body');
  expect(kinds(t.entries)).toEqual(['task-start', 'text', 'task-start']);
  const text = t.entries[1];
  if (text?.kind === 'text') expect(text.text).toBe('half-said');
});

test('consecutive shell:stdout chunks coalesce into a single shell-stdout entry', () => {
  const s = apply(initialState(0), [
    { kind: 'task:start', path: ['sh'], taskKind: 'run' },
    { kind: 'shell:stdout', path: ['sh'], chunk: 'line1\n' },
    { kind: 'shell:stdout', path: ['sh'], chunk: 'line2\n' },
    { kind: 'task:end', path: ['sh'], taskKind: 'run', durationMs: 0 },
  ]);
  const t = task(s, 'sh');
  expect(kinds(t.entries)).toEqual(['task-start', 'shell-stdout', 'task-end']);
  const out = t.entries[1];
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
  const t = task(s, 'sh');
  expect(kinds(t.entries)).toEqual([
    'task-start',
    'shell-stdout',
    'shell-stderr',
    'shell-stdout',
    'task-end',
  ]);
});

test('shell:stdout events arriving without an active task are ignored', () => {
  const s = apply(initialState(0), [{ kind: 'shell:stdout', path: ['sh'], chunk: 'x' }]);
  expect(s.liveTasks.size).toBe(0);
});
