import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { Workflow } from '../io';
import { theme } from './theme';

export interface HeaderProps {
  workflow: Workflow;
}

export function Header({ workflow }: HeaderProps): ReactElement {
  const { namespace, name, version, title, summary } = workflow.document;

  return (
    <Box
      alignSelf="flex-start"
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
    >
      <Text bold color={theme.accent}>
        {namespace}/{name}
      </Text>
      <Text bold color={theme.accent}>
        v{version}
      </Text>
      {title && title.length > 0 ? <Text>{title}</Text> : null}
      {summary && summary.length > 0 ? <Text color={theme.dim}>{summary}</Text> : null}
    </Box>
  );
}
