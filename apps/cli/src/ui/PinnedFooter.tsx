// src/ui/PinnedFooter.tsx
import { Box, Text } from 'ink';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { formatElapsed, truncate } from './format';
import { theme } from './theme';
import { trainLine } from './train';
import type { State } from './useEngineState';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const TICK_MS = 200;

// Disambiguate same-leaf-name siblings under different parents.
function leafLabel(key: string): string {
  const parts = key.split('>');
  if (parts.length <= 1) return key;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// Single footer-level tick drives both spinner frame and train phase. Nothing
// in the Static log above re-renders when `now` updates.
export function PinnedFooter({ state }: { state: State }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const frame = Math.floor(now / TICK_MS) % SPINNER_FRAMES.length;
  const inFlight = state.runningPaths.length;
  const elapsed = formatElapsed(now - state.startedAt);
  // `runningPaths` is mutated in place by the reducer; the array reference is
  // stable so we depend on `state.revision` to re-memo on engine events. The
  // 200ms spinner tick only changes `now` and skips this memo.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision tracks in-place mutations of runningPaths
  const namesLine = useMemo(
    () => (inFlight > 0 ? truncate(state.runningPaths.map(leafLabel).join(' · '), 120) : null),
    [inFlight, state.runningPaths, state.revision],
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
        <Text color={theme.accent}>{trainLine(now)}</Text>
      </Box>
      <Box>
        <Text color={theme.dim}>
          {elapsed} • {state.totalTasks} tasks • {inFlight} in flight • ${state.costUsd.toFixed(2)}
        </Text>
      </Box>
    </Box>
  );
}
