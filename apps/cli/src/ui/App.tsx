// src/ui/App.tsx
import { Box, renderToString, useStdout } from 'ink';
import { type ReactElement, useLayoutEffect, useMemo } from 'react';
import { PinnedFooter } from './PinnedFooter';
import { RenderItemRow } from './RenderItemRow';
import { splitAtLiveBoundary } from './renderItems';
import { SummaryCard } from './SummaryCard';
import { type EngineStore, useEngineStore } from './useEngineState';

export interface AppProps {
  store: EngineStore;
  finishedAt: number | null;
}

export function App({ store, finishedAt }: AppProps): ReactElement {
  const state = useEngineStore(store);
  const { write } = useStdout();

  // Wire the store's commit callback once Ink's coordinated stdout writer
  // (`useStdout().write`) is available. The callback runs synchronously inside
  // every dispatch — *outside* React's render cycle — so renderToString here
  // does not re-enter the live container's reconciler.
  useLayoutEffect(() => {
    store.setCommitFn(() => {
      const { staticItems, commitEntryCount } = splitAtLiveBoundary(store.state.pending);
      if (staticItems.length === 0) return;
      const ansi = renderToString(
        <Box flexDirection="column">
          {staticItems.map((item) => (
            <RenderItemRow key={item.id} item={item} />
          ))}
        </Box>,
        { columns: process.stdout.columns || 80 },
      );
      if (ansi.length > 0) write(`${ansi}\n`);
      store.state.pending.splice(0, commitEntryCount);
    });
    return () => {
      store.setCommitFn(() => {});
    };
  }, [store, write]);

  // `pending` is mutated in place by the reducer / commit splice; memo on revision.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision tracks in-place mutations of pending
  const liveItems = useMemo(() => splitAtLiveBoundary(state.pending).liveItems, [
    state.pending,
    state.revision,
  ]);

  return (
    <>
      {liveItems.map((item) => (
        <RenderItemRow key={item.id} item={item} />
      ))}

      {finishedAt == null ? (
        <PinnedFooter state={state} />
      ) : (
        <SummaryCard state={state} finishedAt={finishedAt} />
      )}
    </>
  );
}
