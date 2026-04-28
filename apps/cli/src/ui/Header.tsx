// src/ui/Header.tsx
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { theme } from './theme';

export interface HeaderProps {
  namespace: string | null;
  name: string;
  version: string | null;
  title: string | null;
  summary: string | null;
}

export function Header({ namespace, name, version, title, summary }: HeaderProps): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.accent}>
        {namespace ? `${namespace}/` : ''}
        {name}
        {version ? ` v${version}` : ''}
      </Text>
      {title ? <Text>{title}</Text> : null}
      {summary ? <Text color={theme.dim}>{summary}</Text> : null}
    </Box>
  );
}
