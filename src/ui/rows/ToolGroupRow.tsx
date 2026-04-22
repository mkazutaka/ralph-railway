import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { theme } from '../theme';
import { inputPreview } from '../toolDisplay';
import type { LogEntry } from '../useEngineState';
import { ResultGutter } from './ResultGutter';
import { RunningDot } from './RunningDot';

export interface ToolGroup {
  name: string;
  uses: Extract<LogEntry, { kind: 'tool-use' }>[];
  results: Map<string, Extract<LogEntry, { kind: 'tool-result' }>>;
}

function fileLabel(use: Extract<LogEntry, { kind: 'tool-use' }>): string {
  return inputPreview(use.name, use.input) || '(unknown)';
}

// Matches claude-code's grouped-Read rendering:
//   ⏺ Reading 3 files…
//     ⎿  src/foo.ts
//        src/bar.ts
//        src/baz.ts
// Currently only Read collapses into a group — see `buildRenderItems`.
export function ToolGroupRow({
  group,
  running,
  errored,
}: {
  group: ToolGroup;
  running: boolean;
  errored: boolean;
}): ReactElement {
  const total = group.uses.length;
  const done = group.uses.filter((u) => group.results.has(u.toolUseId)).length;
  const header = running
    ? `Reading ${total} ${total === 1 ? 'file' : 'files'}…`
    : `Read ${total} ${total === 1 ? 'file' : 'files'}`;

  return (
    <Box flexDirection="column">
      <Box>
        <RunningDot running={running} errored={errored} />
        <Text bold>{header}</Text>
        {!running && done < total ? <Text color={theme.dim}>{` (${done}/${total})`}</Text> : null}
      </Box>
      <ResultGutter>
        {group.uses.map((u) => (
          <Text key={`rd-${u.toolUseId}`} color={theme.dim}>
            {fileLabel(u)}
          </Text>
        ))}
      </ResultGutter>
    </Box>
  );
}
