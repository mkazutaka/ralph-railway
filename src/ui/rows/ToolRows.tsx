import type { StructuredPatchHunk } from 'diff';
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { truncate, wrapLines } from '../format';
import { theme } from '../theme';
import { inputPreview } from '../toolDisplay';
import type { LogEntry } from '../useEngineState';
import { MAX_LINE_COLS, MAX_RESULT_LINES, RESULT_WRAP_COLS } from './constants';
import { EditDiffRow } from './EditDiffRow';
import { ResultGutter } from './ResultGutter';
import { RunningDot } from './RunningDot';

type ToolUseEntry = Extract<LogEntry, { kind: 'tool-use' }>;
type ToolResultEntry = Extract<LogEntry, { kind: 'tool-result' }>;

export function ToolUseRow({
  entry,
  running,
  errored,
  editHunks,
}: {
  entry: ToolUseEntry;
  running: boolean;
  errored: boolean;
  editHunks?: StructuredPatchHunk[];
}): ReactElement {
  const preview = inputPreview(entry.name, entry.input);
  const header = (
    <Box>
      <RunningDot running={running} errored={errored} />
      <Text bold>{entry.name}</Text>
      {preview ? <Text color={theme.dim}>({truncate(preview, MAX_LINE_COLS)})</Text> : null}
    </Box>
  );
  if (!editHunks || editHunks.length === 0) return header;
  return (
    <Box flexDirection="column">
      {header}
      <EditDiffRow hunks={editHunks} />
    </Box>
  );
}

export function ToolResultRow({ entry }: { entry: ToolResultEntry }): ReactElement | null {
  const wrapped = wrapLines(entry.content.trimEnd(), RESULT_WRAP_COLS);
  if (wrapped.length === 0) return null;
  // claude-code heuristic: if exactly one extra line sits beyond the fold,
  // just show it — "… +1 line" costs as much space as the line itself.
  const showAll = wrapped.length <= MAX_RESULT_LINES + 1;
  const shown = showAll ? wrapped : wrapped.slice(0, MAX_RESULT_LINES);
  const hidden = wrapped.length - shown.length;
  const color = entry.isError ? theme.error : theme.dim;
  return (
    <ResultGutter>
      {shown.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: deterministic split of entry.content
        <Text key={`tr-${idx}`} color={color}>
          {line}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text color={theme.dim}>{`… +${hidden} line${hidden === 1 ? '' : 's'}`}</Text>
      ) : null}
    </ResultGutter>
  );
}
