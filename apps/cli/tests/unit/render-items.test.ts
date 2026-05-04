import { expect, test } from 'bun:test';
import { buildItemsForTask } from '../../src/ui/renderItems';
import type { LogEntry } from '../../src/ui/useEngineState';

test('buildItemsForTask renders a finished task as task-start + task-end entries', () => {
  const entries: LogEntry[] = [
    { kind: 'task-start', depth: 0, name: 'a', taskKind: 'set' },
    { kind: 'task-end', depth: 0, name: 'a', durationMs: 1, costUsd: null, toolsCount: null },
  ];

  const items = buildItemsForTask(entries);

  expect(items.map((item) => item.id)).toEqual(['log-0', 'log-1']);
  for (const item of items) {
    expect(item.running).toBe(false);
    expect(item.errored).toBe(false);
  }
});

test('buildItemsForTask flags an unresolved tool-use as running', () => {
  const entries: LogEntry[] = [
    { kind: 'task-start', depth: 0, name: 'a', taskKind: 'call' },
    { kind: 'tool-use', depth: 0, toolUseId: 't1', name: 'Bash', input: { command: 'sleep 1' } },
  ];

  const items = buildItemsForTask(entries);

  expect(items).toHaveLength(2);
  const tu = items[1];
  expect(tu?.running).toBe(true);
  expect(tu?.errored).toBe(false);
});

test('buildItemsForTask groups consecutive Reads into a single group item', () => {
  const entries: LogEntry[] = [
    { kind: 'tool-use', depth: 0, toolUseId: 'r1', name: 'Read', input: { file_path: 'a' } },
    { kind: 'tool-use', depth: 0, toolUseId: 'r2', name: 'Read', input: { file_path: 'b' } },
    { kind: 'tool-result', depth: 0, toolUseId: 'r1', name: 'Read', content: 'a', isError: false },
    { kind: 'tool-result', depth: 0, toolUseId: 'r2', name: 'Read', content: 'b', isError: false },
    { kind: 'task-end', depth: 0, name: 'done', durationMs: 1, costUsd: null, toolsCount: null },
  ];

  const items = buildItemsForTask(entries);

  expect(items[0]?.kind).toBe('group');
  if (items[0]?.kind === 'group') {
    expect(items[0].running).toBe(false);
    expect(items[0].errored).toBe(false);
    expect(items[0].group.uses).toHaveLength(2);
  }
  expect(items[1]?.kind).toBe('entry');
});

test('buildItemsForTask absorbs successful Edit tool-result rows', () => {
  const entries: LogEntry[] = [
    {
      kind: 'tool-use',
      depth: 0,
      toolUseId: 'e1',
      name: 'Edit',
      input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' },
    },
    { kind: 'tool-result', depth: 0, toolUseId: 'e1', name: 'Edit', content: 'ok', isError: false },
  ];

  const items = buildItemsForTask(entries);

  expect(items).toHaveLength(1);
  expect(items[0]?.kind).toBe('entry');
});
