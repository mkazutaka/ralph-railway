// src/ui/RenderItemRow.tsx
import { Box } from 'ink';
import type { ReactElement } from 'react';
import type { RenderItem } from './renderItems';
import { LogEntryRow } from './rows/LogEntryRow';
import { ToolGroupRow } from './rows/ToolGroupRow';

/**
 * Single row view for a `RenderItem`. Used in both the `<Static>` history and
 * the live region so the two share one visual layout.
 */
export function RenderItemRow({ item }: { item: RenderItem }): ReactElement {
  return (
    <Box marginBottom={item.marginBottom}>
      {item.kind === 'group' ? (
        <ToolGroupRow group={item.group} running={item.running} errored={item.errored} />
      ) : (
        <LogEntryRow
          entry={item.entry}
          running={item.running}
          errored={item.errored}
          editHunks={item.editHunks}
        />
      )}
    </Box>
  );
}
