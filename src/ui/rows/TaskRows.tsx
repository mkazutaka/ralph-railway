import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatDuration, wrapLines } from '../format';
import { glyph, theme } from '../theme';
import type { LogEntry } from '../useEngineState';
import { MAX_LINE_COLS } from './constants';

type TaskStartEntry = Extract<LogEntry, { kind: 'task-start' }>;
type TaskEndEntry = Extract<LogEntry, { kind: 'task-end' }>;
type TaskErrorEntry = Extract<LogEntry, { kind: 'task-error' }>;
type TaskSkipEntry = Extract<LogEntry, { kind: 'task-skip' }>;
type IterationEntry = Extract<LogEntry, { kind: 'iteration' }>;

export function TaskStartRow({ entry }: { entry: TaskStartEntry }): ReactElement {
  return (
    <Box>
      <Text color={theme.running}>{glyph.pending} </Text>
      <Text bold color={theme.running}>
        {entry.name}
      </Text>
    </Box>
  );
}

export function TaskEndRow({ entry }: { entry: TaskEndEntry }): ReactElement {
  const parts: string[] = [formatDuration(entry.durationMs)];
  if (entry.costUsd != null) parts.push(`$${entry.costUsd.toFixed(3)}`);
  if (entry.toolsCount != null && entry.toolsCount > 0) {
    parts.push(`${entry.toolsCount} tool${entry.toolsCount === 1 ? '' : 's'}`);
  }
  return (
    <Box>
      <Text color={theme.done}>{glyph.done} </Text>
      <Text bold color={theme.done}>
        {entry.name}
      </Text>
      <Text color={theme.dim}> [{parts.join(' · ')}]</Text>
    </Box>
  );
}

export function TaskErrorRow({ entry }: { entry: TaskErrorEntry }): ReactElement {
  const lines = wrapLines(entry.message, MAX_LINE_COLS);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.error}>{glyph.error} </Text>
        <Text bold color={theme.error}>
          {entry.name}
        </Text>
      </Box>
      {lines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: deterministic split of entry.message
        <Box key={`err-${idx}`}>
          <Text color={theme.error}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function TaskSkipRow({ entry }: { entry: TaskSkipEntry }): ReactElement {
  return (
    <Box>
      <Text color={theme.dim}>{glyph.arrow} </Text>
      <Text color={theme.dim}>{entry.name} (skipped)</Text>
    </Box>
  );
}

export function IterationRow({ entry }: { entry: IterationEntry }): ReactElement {
  return (
    <Box>
      <Text color={theme.dim}>
        {glyph.arrow} iteration {entry.displayIndex} of {entry.total != null ? entry.total : '?'}
      </Text>
    </Box>
  );
}
