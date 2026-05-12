import { Box } from 'ink';
import { memo, type ReactElement } from 'react';
import type { ActivityEntry, LogEntry } from './hooks/useEngineState';
import { computeHunks, extractEdits, isEditToolName } from './rows/EditDiffRow';
import { IterationRow, TaskEndRow, TaskErrorRow, TaskSkipRow, TaskStartRow } from './rows/TaskRows';
import { ShellStderrRow, ShellStdoutRow, TextRow, ThinkingRow } from './rows/TextRows';
import { ToolGroupRow } from './rows/ToolGroupRow';
import { ToolResultRow, ToolUseRow } from './rows/ToolRows';

type ToolUseEntry = Extract<ActivityEntry, { kind: 'tool-use' }>;
type ToolResultEntry = Extract<ActivityEntry, { kind: 'tool-result' }>;

export const ChunkRow = memo(function ChunkRow({
  entries,
}: {
  entries: LogEntry[];
}): ReactElement | null {
  if (entries.length === 0) return null;

  if (entries.length === 2) {
    const [a, b] = entries;
    if (a?.kind === 'tool-use' && b?.kind === 'tool-result' && a.activityId === b.activityId) {
      return <ToolPair use={a} result={b} />;
    }
  }

  const uses = entries.filter((e): e is ToolUseEntry => e.kind === 'tool-use');
  if (uses.length >= 2 && uses.every((u) => u.name === 'Read')) {
    const results = new Map<string, ToolResultEntry>(
      entries
        .filter((e): e is ToolResultEntry => e.kind === 'tool-result')
        .map((r) => [r.activityId, r]),
    );
    const errored = Array.from(results.values()).some((r) => r.isError);
    const running = uses.length > results.size;
    return (
      <Box marginBottom={1}>
        <ToolGroupRow group={{ name: 'Read', uses, results }} running={running} errored={errored} />
      </Box>
    );
  }

  return (
    <>
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: chunk contents are positionally addressed and don't reorder
        <Box key={`${entry.kind}-${i}`} marginBottom={1}>
          <SingleRow entry={entry} running={entry.kind === 'tool-use'} errored={false} />
        </Box>
      ))}
    </>
  );
});

function ToolPair({ use, result }: { use: ToolUseEntry; result: ToolResultEntry }): ReactElement {
  const editHunks = isEditToolName(use.name)
    ? computeHunks(extractEdits(use.name, use.input))
    : undefined;
  // Edit/Write/MultiEdit success: result is folded into the use's inline diff
  // (ToolUseRow renders the diff when editHunks is present).
  if (isEditToolName(use.name) && !result.isError) {
    return (
      <Box marginBottom={1}>
        <ToolUseRow entry={use} running={false} errored={false} editHunks={editHunks} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <ToolUseRow entry={use} running={false} errored={result.isError} editHunks={editHunks} />
      <ToolResultRow entry={result} />
    </Box>
  );
}

const SingleRow = memo(function SingleRow({
  entry,
  running,
  errored,
}: {
  entry: LogEntry;
  running: boolean;
  errored: boolean;
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
    case 'tool-use': {
      const editHunks = isEditToolName(entry.name)
        ? computeHunks(extractEdits(entry.name, entry.input))
        : undefined;
      return <ToolUseRow entry={entry} running={running} errored={errored} editHunks={editHunks} />;
    }
    case 'tool-result':
      return <ToolResultRow entry={entry} />;
  }
});
