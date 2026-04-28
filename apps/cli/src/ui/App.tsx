// src/ui/App.tsx
import { Static } from 'ink';
import { type ReactElement, useEffect, useMemo } from 'react';
import type { EngineBus } from '../engine/events';
import type { Workflow } from '../io';
import { Header } from './Header';
import { PinnedFooter } from './PinnedFooter';
import { RenderItemRow } from './RenderItemRow';
import { extractHeader, splitAtLiveBoundary } from './renderItems';
import { SummaryCard } from './SummaryCard';
import { useEngineState } from './useEngineState';

export interface AppProps {
  bus: EngineBus;
  wf: Workflow;
  finishedAt: number | null;
}

export function App({ bus, wf, finishedAt }: AppProps): ReactElement {
  const { state, dispatch } = useEngineState();

  useEffect(() => bus.on(dispatch), [bus, dispatch]);

  const header = useMemo(() => extractHeader(wf), [wf]);

  const { staticItems, liveItems } = useMemo(
    () => splitAtLiveBoundary(state.logEntries, header),
    [state.logEntries, header],
  );

  return (
    <>
      <Static items={staticItems}>
        {(item) =>
          item.kind === 'header' ? (
            <Header key={item.id} {...item.header} />
          ) : (
            <RenderItemRow key={item.id} item={item} />
          )
        }
      </Static>

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
