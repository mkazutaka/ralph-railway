import { renderToString, useStdout } from 'ink';
import { type ReactElement, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { ChunkRow } from './ChunkRow';
import { Footer } from './Footer';
import type { EngineStore, LogEntry } from './hooks/useEngineState';
import { RunningTaskTree } from './RunningTaskTree';
import { SummaryCard } from './SummaryCard';

export interface AppProps {
  store: EngineStore;
  finishedAt: number | null;
}

export function App({ store, finishedAt }: AppProps): ReactElement {
  const state = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.state,
  );
  const { write } = useStdout();

  const writeChunkToScrollback = useCallback(
    (entries: LogEntry[]) => {
      if (entries.length === 0) return;
      const ansi = renderToString(<ChunkRow entries={entries} />, {
        columns: process.stdout.columns || 80,
      });
      if (ansi.length > 0) write(`${ansi}\n`);
    },
    [write],
  );

  useLayoutEffect(() => {
    store.setStdOutWrite(writeChunkToScrollback);
    return () => store.setStdOutWrite(null);
  }, [store, writeChunkToScrollback]);

  return (
    <>
      {state.runningTasks.map((task) => (
        <RunningTaskTree key={task.taskId} task={task} revision={state.revision} />
      ))}

      {finishedAt == null ? (
        <Footer state={state} />
      ) : (
        <SummaryCard state={state} finishedAt={finishedAt} />
      )}
    </>
  );
}
