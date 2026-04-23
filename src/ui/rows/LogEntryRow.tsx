import type { StructuredPatchHunk } from 'diff';
import { memo, type ReactElement } from 'react';
import type { LogEntry } from '../useEngineState';
import { IterationRow, TaskEndRow, TaskErrorRow, TaskSkipRow, TaskStartRow } from './TaskRows';
import { ShellStderrRow, ShellStdoutRow, TextRow, ThinkingRow } from './TextRows';
import { ToolResultRow, ToolUseRow } from './ToolRows';

// `entry` references live in `state.logEntries` and are never mutated once
// appended (the reducer always spreads into a new array), and `running` is a
// primitive — so shallow-compare via `memo` skips re-renders for rows whose
// props didn't change even when the enclosing live region re-renders.
export const LogEntryRow = memo(function LogEntryRow({
  entry,
  running = false,
  errored = false,
  editHunks,
}: {
  entry: LogEntry;
  running?: boolean;
  errored?: boolean;
  editHunks?: StructuredPatchHunk[];
}): ReactElement | null {
  switch (entry.kind) {
    case 'task-start':
      return <TaskStartRow entry={entry} />;
    case 'task-end':
      return <TaskEndRow entry={entry} />;
    case 'task-error':
      return <TaskErrorRow entry={entry} />;
    case 'task-skip':
      return <TaskSkipRow entry={entry} />;
    case 'iteration':
      return <IterationRow entry={entry} />;
    case 'text':
      return <TextRow entry={entry} />;
    case 'thinking':
      return <ThinkingRow entry={entry} />;
    case 'shell-stdout':
      return <ShellStdoutRow entry={entry} />;
    case 'shell-stderr':
      return <ShellStderrRow entry={entry} />;
    case 'tool-use':
      return <ToolUseRow entry={entry} running={running} errored={errored} editHunks={editHunks} />;
    case 'tool-result':
      return <ToolResultRow entry={entry} />;
  }
});
