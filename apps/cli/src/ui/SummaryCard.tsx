import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { State } from './hooks/useEngineState';
import { glyph, theme } from './utils/theme';

export function SummaryCard({
  state,
  finishedAt,
}: {
  state: State;
  finishedAt: number;
}): ReactElement {
  const ok = state.erroredTasks === 0;
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
          {state.totalTasks} total {glyph.done} {state.completedTasks} {glyph.error}{' '}
          {state.erroredTasks}
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

function formatTotalElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${rs.toString().padStart(2, '0')}s`;
  return `${m.toString().padStart(2, '0')}:${rs.toString().padStart(2, '0')}`;
}
