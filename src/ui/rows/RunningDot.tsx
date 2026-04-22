import { Text } from 'ink';
import type { ReactElement } from 'react';
import { glyph, theme } from '../theme';
import { useBlink } from '../useBlink';

/**
 * The claude-code-style ToolUseLoader dot: blue & blinking while running,
 * solid green when resolved, red on error. Shared by every row that fronts a
 * tool-use state (single tool rows + grouped read rows) so the animation and
 * color mapping stay identical across them.
 */
export function RunningDot({
  running,
  errored,
}: {
  running: boolean;
  errored: boolean;
}): ReactElement {
  const blinkOn = useBlink(running);
  const dot = running && !blinkOn ? ' ' : glyph.bullet;
  const color = running ? theme.running : errored ? theme.error : theme.done;
  return <Text color={color}>{dot} </Text>;
}
