// src/ui/SummaryCard.tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatTotalElapsed } from './format';
import { glyph, theme } from './theme';
import type { State } from './useEngineState';

function summarize(state: State): { done: number; error: number } {
  let done = 0;
  let error = 0;
  for (const e of state.logEntries) {
    if (e.kind === 'task-end') done += 1;
    else if (e.kind === 'task-error') error += 1;
  }
  return { done, error };
}

export function SummaryCard({
  state,
  finishedAt,
}: {
  state: State;
  finishedAt: number;
}): ReactElement {
  const s = summarize(state);
  const ok = s.error === 0;
  const headColor = ok ? theme.done : theme.error;
  const headLabel = ok ? 'finished' : 'finished with errors';
  const elapsedMs = finishedAt - state.startedAt;
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={headColor}
      paddingX={1}
    >
      <Box>
        <Text bold color={headColor}>
          {ok ? glyph.done : glyph.error} {headLabel}
        </Text>
      </Box>
      <Box>
        <Text color={theme.dim}>tasks </Text>
        <Text>
          {state.totalTasks} total {glyph.done} {s.done} {glyph.error} {s.error}
        </Text>
      </Box>
      <Box>
        <Text color={theme.dim}>elapsed </Text>
        <Text>{formatTotalElapsed(elapsedMs)}</Text>
      </Box>
      <Box>
        <Text color={theme.dim}>cost </Text>
        <Text>${state.costUsd.toFixed(4)}</Text>
      </Box>
    </Box>
  );
}
