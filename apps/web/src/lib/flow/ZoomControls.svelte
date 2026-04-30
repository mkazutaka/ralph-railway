<!--
  Custom zoom controls panel for the workflow canvas.

  Visual contract mirrors `apps/web/design/app.pen` node `VUAuV`
  ("Zoom Controls"): a horizontal pill with three slots — minus button,
  centred percentage label, plus button — sitting on `$bg-elevated` with
  a 1px `$border-default` outline and `$radius-lg` corners. Each button
  is 32×32 with a Lucide icon at 14px in `$text-secondary`.

  We deliberately do not use xyflow's built-in `<Controls>` here because
  it ships a vertical zoom-in / zoom-out / fit-view stack with no
  percentage readout. The design calls for the percentage to be visible
  at all times, so we render a custom panel that subscribes to the
  reactive viewport (`useViewport`) for the live zoom level and uses the
  imperative `zoomIn` / `zoomOut` helpers (`useSvelteFlow`) for the
  button actions.

  This component MUST be rendered inside a `<SvelteFlow>` (its hooks
  rely on the SvelteFlow store context) — typically wrapped in a
  `<Panel position="bottom-right">`.

  Accessibility: the readout itself is NOT a live region. Wheel-zoom
  produces continuous floating-point updates that would force a screen
  reader to chatter every frame; instead, the readout carries a static
  `aria-label` and the buttons are individually labelled. Users who need
  the current zoom level can read it on demand from the % element.
-->
<script lang="ts">
  import { useSvelteFlow, useViewport } from '@xyflow/svelte';
  import Minus from 'lucide-svelte/icons/minus';
  import Plus from 'lucide-svelte/icons/plus';

  // SvelteFlow defaults (`@xyflow/svelte`): minZoom = 0.5, maxZoom = 2. We
  // mirror them here so the buttons can grey-out at the boundaries instead
  // of clicking through silently. If a future scenario tunes these via
  // `<SvelteFlow minZoom={...}>`, the prop will need to be plumbed in or
  // read from `useStore()` — for now matching defaults is sufficient.
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  const ZOOM_EPS = 1e-3;

  const { zoomIn, zoomOut } = useSvelteFlow();
  const viewport = useViewport();

  const zoomPercent = $derived(Math.round(viewport.current.zoom * 100));
  const atMin = $derived(viewport.current.zoom <= MIN_ZOOM + ZOOM_EPS);
  const atMax = $derived(viewport.current.zoom >= MAX_ZOOM - ZOOM_EPS);
</script>

<div
  class="flex items-center overflow-hidden rounded-lg border border-(--color-border-default) bg-(--color-bg-elevated)"
  role="group"
  aria-label="Canvas zoom"
>
  <button
    type="button"
    aria-label="Zoom out"
    disabled={atMin}
    class="flex h-8 w-8 items-center justify-center text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-(--color-text-secondary)"
    onclick={() => zoomOut()}
  >
    <Minus class="h-3.5 w-3.5" aria-hidden="true" />
  </button>
  <span
    class="min-w-[44px] px-1 text-center font-[Inter] text-[12px] leading-none text-(--color-text-secondary) tabular-nums"
    aria-label="{zoomPercent} percent zoom"
  >
    {zoomPercent}%
  </span>
  <button
    type="button"
    aria-label="Zoom in"
    disabled={atMax}
    class="flex h-8 w-8 items-center justify-center text-(--color-text-secondary) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-(--color-text-secondary)"
    onclick={() => zoomIn()}
  >
    <Plus class="h-3.5 w-3.5" aria-hidden="true" />
  </button>
</div>
