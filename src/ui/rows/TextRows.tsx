import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { glyph, theme } from '../theme';
import { textLastLines } from '../toolDisplay';
import type { LogEntry } from '../useEngineState';
import { MAX_LINE_COLS } from './constants';

type TextEntry = Extract<LogEntry, { kind: 'text' }>;
type ThinkingEntry = Extract<LogEntry, { kind: 'thinking' }>;

export function TextRow({ entry }: { entry: TextEntry }): ReactElement {
  const lines = entry.text.trim().split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: deterministic split of entry.text
        <Box key={`tx-${idx}`}>
          <Text color={theme.text}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ThinkingRow({ entry }: { entry: ThinkingEntry }): ReactElement {
  const lines = textLastLines(entry.text, 6, MAX_LINE_COLS);
  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: deterministic split of entry.text
        <Box key={`th-${idx}`}>
          <Text color={theme.thinking} italic>
            {idx === 0 ? `${glyph.thinking} ${line}` : line}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
