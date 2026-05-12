import { Box, Text } from 'ink';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import type { RunningTask, State } from './hooks/useEngineState';
import { TrainLine } from './TrainLine';
import { formatElapsed, truncate } from './utils/format';
import { theme } from './utils/theme';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const TICK_MS = 200;

function leafLabel(task: RunningTask): string {
  return task.name;
}

// Single footer-level tick drives both spinner frame and train phase. Nothing
// already committed to stdout history re-renders when `now` updates.
export function Footer({ state }: { state: State }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const frame = Math.floor(now / TICK_MS) % SPINNER_FRAMES.length;
  const inFlight = state.runningTasks.length;
  const elapsed = formatElapsed(now - state.startedAt);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision tracks in-place mutations of runningTasks
  const namesLine = useMemo(
    () => (inFlight > 0 ? truncate(state.runningTasks.map(leafLabel).join(' · '), 120) : null),
    [inFlight, state.runningTasks, state.revision],
  );

  return (
    <Box flexDirection="column">
      {namesLine != null ? (
        <Box>
          <Text color={theme.running}>{SPINNER_FRAMES[frame]} </Text>
          <Text color={theme.dim}>current task: </Text>
          <Text>{namesLine}</Text>
        </Box>
      ) : null}
      <Box>
        <TrainLine />
      </Box>
      <Box>
        <Text color={theme.dim}>
          {elapsed} • {state.totalTasks} tasks • {inFlight} in flight • ${state.costUsd.toFixed(2)}
        </Text>
      </Box>
    </Box>
  );
}
