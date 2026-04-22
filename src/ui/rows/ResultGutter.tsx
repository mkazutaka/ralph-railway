import { Box, type BoxProps, Text } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { glyph, theme } from '../theme';

/**
 * Two-column layout with the dim `⎿` gutter on the left and wrapping content
 * on the right. Used by tool-result, grouped-tool, and edit-diff rows so the
 * gutter stays visually identical across every shape that needs it.
 */
export function ResultGutter({
  children,
  flexDirection = 'column',
}: {
  children: ReactNode;
  flexDirection?: BoxProps['flexDirection'];
}): ReactElement {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text color={theme.dim}>{`  ${glyph.result}  `}</Text>
      </Box>
      <Box flexDirection={flexDirection} flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}
