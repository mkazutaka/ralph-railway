import { expect, test } from 'bun:test';
import { renderToString } from 'ink';
import { ChunkRow } from '../../src/ui/ChunkRow';
import type { LogEntry } from '../../src/ui/hooks/useEngineState';

function render(entries: LogEntry[]): string {
  return renderToString(<ChunkRow entries={entries} />, { columns: 80 });
}

test('a single task-start chunk renders the task name', () => {
  const out = render([{ kind: 'task-start', name: 'greet', taskId: 't1' }]);
  expect(out).toContain('greet');
});

test('a tool-use+result pair shows both rows (Bash)', () => {
  const out = render([
    { kind: 'tool-use', activityId: 't1', name: 'Bash', input: { command: 'ls' } },
    { kind: 'tool-result', activityId: 't1', content: 'a.txt', isError: false },
  ]);
  expect(out).toContain('Bash');
  expect(out).toContain('a.txt');
});

test('an Edit success pair absorbs the result into the diff', () => {
  const out = render([
    {
      kind: 'tool-use',
      activityId: 'e1',
      name: 'Edit',
      input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' },
    },
    { kind: 'tool-result', activityId: 'e1', content: 'ok', isError: false },
  ]);
  // Edit row + diff lines, but the result content "ok" is not shown.
  expect(out).toContain('Edit');
  expect(out).not.toContain('ok');
});

test('≥2 Read uses with results render as a grouped header', () => {
  const out = render([
    { kind: 'tool-use', activityId: 'r1', name: 'Read', input: { file_path: 'a' } },
    { kind: 'tool-use', activityId: 'r2', name: 'Read', input: { file_path: 'b' } },
    { kind: 'tool-result', activityId: 'r1', content: 'a', isError: false },
    { kind: 'tool-result', activityId: 'r2', content: 'b', isError: false },
  ]);
  expect(out).toContain('Read');
});

test('a lone tool-use (no result) still renders the tool name', () => {
  const out = render([
    { kind: 'tool-use', activityId: 't1', name: 'Bash', input: { command: 'sleep' } },
  ]);
  expect(out).toContain('Bash');
});
