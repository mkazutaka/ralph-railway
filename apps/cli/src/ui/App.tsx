// src/ui/App.tsx
import { Static } from 'ink';
import { type ReactElement, useEffect, useMemo } from 'react';
import type { EngineBus } from '../engine/events';
import { PinnedFooter } from './PinnedFooter';
import { RenderItemRow } from './RenderItemRow';
import { splitAtLiveBoundary } from './renderItems';
import { SummaryCard } from './SummaryCard';
import { useEngineState } from './useEngineState';

export interface AppProps {
  bus: EngineBus;
  finishedAt: number | null;
}

export function App({ bus, finishedAt }: AppProps): ReactElement {
  const { state, dispatch } = useEngineState();

  useEffect(() => bus.on(dispatch), [bus, dispatch]);

  // `state.logEntries` is mutated in place by the reducer — its reference is
  // stable across dispatches, so we re-memo on `state.revision` instead.
  // Biome's exhaustive-deps can't see the mutation and flags `state.revision`
  // as redundant; the suppression below preserves the intentional dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision tracks in-place mutations of logEntries
  const { staticItems, liveItems } = useMemo(
    () => splitAtLiveBoundary(state.logEntries),
    [state.logEntries, state.revision],
  );

  return (
    <>
      <Static items={staticItems}>{(item) => <RenderItemRow key={item.id} item={item} />}</Static>

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
