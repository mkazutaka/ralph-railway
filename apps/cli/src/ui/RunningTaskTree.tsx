import { Box } from 'ink';
import { memo, type ReactElement } from 'react';
import { ChunkRow } from './ChunkRow';
import type { LogEntry, RunningActivity, RunningTask } from './hooks/useEngineState';

// Live region for one running task: each in-flight activity rendered as one
// chunk. The task header was already written to scrollback at task:start.
export const RunningTaskTree = memo(
  function RunningTaskTree({ task }: { task: RunningTask; revision: number }): ReactElement | null {
    if (task.runningActivities.length === 0) return null;
    return (
      <Box flexDirection="column">
        {task.runningActivities.map((activity) => (
          <ChunkRow key={keyOf(activity)} entries={activityToChunk(activity)} />
        ))}
      </Box>
    );
  },
  (prev, next) => prev.task === next.task && prev.revision === next.revision,
);

function keyOf(activity: RunningActivity): string {
  if (activity.kind === 'tool') return activity.use.activityId;
  if (activity.kind === 'read-group') return activity.uses[0]?.activityId ?? 'read-group';
  return activity.activityId;
}

function activityToChunk(activity: RunningActivity): LogEntry[] {
  if (activity.kind === 'read-group') {
    return [...activity.uses, ...Array.from(activity.results.values())];
  }
  if (activity.kind === 'tool') {
    return [activity.use];
  }
  return [{ kind: activity.kind, activityId: activity.activityId, text: activity.text }];
}
