<!--
  Workflow flow visualisation component.

  Visual contract mirrors `apps/web/design/app.pen` "Canvas Area" frame
  (`EbnDF` for the dark theme): a dark dotted-grid canvas with elevated
  nodes connected by `border-strong` edges, an elevated minimap in the
  bottom-left, a horizontal zoom-controls pill (`VUAuV`) in the
  bottom-right, a Canvas Help Hint pill (`GUITe`) along the bottom
  centre, and a Canvas Toolbar (`gskMk`) along the top-center. The nodes
  themselves are rendered through the custom `WorkflowNode` component
  (`./WorkflowNode.svelte`) which matches the design's left-stripe + icon
  + title/subtitle card layout (and the loop-container variant for `for`).

  The data layer (positions, edges) is owned by the `lib/workflow/`
  adapters — this component only customises rendering. We register the
  node type once at module scope so the registry is reference-stable
  and SvelteFlow does not re-build its internal node-type cache between
  renders (a fresh inline `nodeTypes={{ … }}` object would invalidate
  the cache on every keystroke).

  Editability contract (insert-pattern scenario):
    The canvas is intentionally read-only. The `insert-pattern` scenario
    flows mutations through the YAML buffer (PatternPicker → server merge
    → invalidateAll → re-render), so dragging nodes / connecting handles
    on the canvas would either be silently discarded on the next
    re-render, or fight with the YAML buffer for ownership of the graph.
    `nodesDraggable` / `nodesConnectable` / `elementsSelectable` are set
    explicitly to make the read-only contract visible in code rather than
    relying on the (defaulted) absence of edit-event handlers.
-->
<script lang="ts">
  import {
    SvelteFlow,
    Background,
    BackgroundVariant,
    MiniMap,
    Panel,
    Position,
    type Node,
    type Edge,
    type NodeTypes,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import Info from 'lucide-svelte/icons/info';
  import WorkflowNode from './WorkflowNode.svelte';
  import ZoomControls from './ZoomControls.svelte';
  import CanvasToolbar, { type CanvasMode } from './CanvasToolbar.svelte';
  import ExecutionBar from './ExecutionBar.svelte';
  import type { RunSummaryDto } from '$features/workflow-editor/entities/dto';

  // The flow graph is read-only here (`insert-pattern` mutates via the YAML
  // buffer + server merge). We still narrow the data generic so consumers
  // get a real shape rather than the unbranded `Record<string, unknown>`
  // default.
  type FlowNodeData = {
    label: string;
    kind: string;
    status?: string;
    bodyStepCount?: number;
    until?: string;
  };
  let {
    nodes,
    edges,
    /**
     * Most recent run for this workflow, used to render the bottom-center
     * Execution Bar (Pencil `hVaDB`). `null` when no runs exist yet — the
     * bar collapses and the help-hint takes its slot. The parent owns the
     * fetch (via the recent-runs panel) so the bar and the sidebar list
     * stay in lockstep without a duplicate request.
     */
    latestRun = null,
  }: {
    nodes: Node<FlowNodeData>[];
    edges: Edge[];
    latestRun?: RunSummaryDto | null;
  } = $props();

  // Once-per-minute clock for the Execution Bar's `relative time` caption.
  // Updating once a minute matches the granularity the recent-runs sidebar
  // already uses (sub-minute drift is invisible because the smallest
  // displayed unit is "Ns" and we round down). Splitting the timer here
  // (rather than threading the recent-runs sidebar's clock through props)
  // keeps the canvas readable even when no sidebar is mounted.
  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(tick);
  });

  // Number of steps in the visualised graph — feeds the Execution Bar's
  // `${n}/${n} steps completed` caption for succeeded runs.
  const totalSteps = $derived(nodes.length);

  // Canvas interaction mode (Pencil node `gskMk` "Canvas Toolbar"). The
  // default `select` matches Figma / Sketch where left-click drags a
  // marquee selection and middle / right mouse pans the canvas; switching
  // to `hand` makes the entire canvas pannable with a single left-click.
  let canvasMode = $state<CanvasMode>('select');

  // SvelteFlow `panOnDrag` accepts `boolean | number[]`. The middle / right
  // mouse-button list is hoisted to module scope so the prop reference stays
  // stable across canvasMode changes (review note P2-3) — `[1, 2]` literals
  // would otherwise produce a fresh array on every render and force xyflow
  // to re-bind its pointer handlers.
  const SELECT_PAN_BUTTONS = Object.freeze([1, 2]) as ReadonlyArray<number>;
  const panOnDrag = $derived<boolean | number[]>(
    canvasMode === 'hand' ? true : (SELECT_PAN_BUTTONS as number[]),
  );
  const selectionOnDrag = $derived(canvasMode === 'select');

  // Register the custom workflow node renderer once so the reference
  // identity stays stable across re-renders.
  const nodeTypes: NodeTypes = { default: WorkflowNode };

  // Style the connection line + edges to match the design's
  // `$border-strong` 2px stroke (Pencil nodes `XOjVs` / `NzNVa`).
  const defaultEdgeOptions = {
    type: 'bezier' as const,
    style: 'stroke: var(--color-border-strong); stroke-width: 2;',
  };

  // SvelteFlow needs source / target positions for bezier edges. The
  // adapters (`to-flow.ts` / `from-dto.ts`) lay nodes out vertically with
  // left/right handles, so attach the positions here once. We do this as a
  // shallow extension that preserves reference identity for nodes whose
  // contents have not changed (review note P0-2): when `nodes` keeps its
  // upstream identity, the mapped array also keeps the per-element identity
  // so xyflow's internal memoisation isn't defeated on every keystroke.
  const enrichedNodes = $derived.by(() => {
    return nodes.map((n) =>
      n.sourcePosition === Position.Right && n.targetPosition === Position.Left
        ? n
        : { ...n, sourcePosition: Position.Right, targetPosition: Position.Left },
    );
  });

  // Map a node `kind` to the matching FlowCraft category-tint CSS var
  // for the minimap. Mirrors the WorkflowNode mapping so the minimap's
  // mini-rectangles read the same colour as the parent node's stripe.
  function minimapNodeColor(node: Node): string {
    const kind = typeof node.data?.kind === 'string' ? (node.data.kind as string) : '';
    switch (kind) {
      case 'run':
        return 'var(--color-node-trigger)';
      case 'set':
        return 'var(--color-node-action)';
      case 'call':
        return 'var(--color-node-ai)';
      case 'for':
      case 'switch':
      case 'fork':
      case 'try':
        return 'var(--color-node-logic)';
      case 'do':
        return 'var(--color-node-output)';
      default:
        // `do` and unknown kinds tint with the `output` swatch so the minimap
        // matches the design's `$node-output` mini-rectangles
        // (`apps/web/design/app.pen` `EbnDF/BWzPi/VvXiW` & `DMmQr`).
        // Previously these fell back to `--color-text-tertiary` which read
        // identical to the minimap's neutral grid (review note frontend #1).
        return 'var(--color-node-output)';
    }
  }
</script>

<!--
  `flowcraft-canvas` scopes our SvelteFlow overrides so they do not bleed
  into other consumers of `@xyflow/svelte/dist/style.css`. The block at
  the bottom retunes the dotted background, edge handles, edge paths,
  controls, and minimap to match the design's elevated-on-canvas surface
  treatment.
-->
<div class="flowcraft-canvas h-full w-full" data-canvas-mode={canvasMode}>
  <SvelteFlow
    nodes={enrichedNodes}
    {edges}
    {nodeTypes}
    {defaultEdgeOptions}
    {panOnDrag}
    {selectionOnDrag}
    nodesDraggable={false}
    nodesConnectable={false}
    elementsSelectable={true}
    fitView
    fitViewOptions={{ padding: 0.2 }}
    proOptions={{ hideAttribution: true }}
  >
    <Background
      variant={BackgroundVariant.Dots}
      gap={24}
      size={2}
      bgColor="var(--color-bg-canvas)"
      patternColor="var(--color-border-subtle)"
    />
    <Panel position="top-center">
      <CanvasToolbar bind:mode={canvasMode} />
    </Panel>
    <Panel position="bottom-right">
      <ZoomControls />
    </Panel>
    <!--
      Bottom-center stack: the Execution Bar (Pencil `hVaDB`, design's
      primary surface for "did the workflow last succeed?") sits on top of
      a smaller help-hint pill. When no run exists yet the bar collapses
      via its own conditional render so only the hint shows — keeping the
      bottom-center region useful on a fresh workflow without leaving an
      empty void where the bar would otherwise be (review note FE-1).
    -->
    <Panel position="bottom-center">
      <div class="flex flex-col items-center gap-2">
        <ExecutionBar {latestRun} {totalSteps} {now} />
        <div
          class="flex items-center gap-1.5 rounded-md border border-(--color-border-default) bg-(--color-bg-elevated)/70 px-3 py-1.5 text-[11px] leading-none text-(--color-text-secondary)"
          aria-hidden="true"
        >
          <Info class="h-3 w-3 shrink-0" />
          <span>{canvasMode === 'hand'
            ? 'Drag the canvas to pan • Scroll to zoom'
            : 'Click a node to inspect • Scroll to zoom'}</span>
        </div>
      </div>
    </Panel>
    <MiniMap
      position="bottom-left"
      ariaLabel="Workflow minimap"
      class="flowcraft-minimap"
      bgColor="var(--color-bg-elevated)"
      nodeColor={minimapNodeColor}
      nodeStrokeColor="var(--color-border-default)"
      nodeStrokeWidth={1}
      nodeBorderRadius={1}
      maskColor="transparent"
      maskStrokeColor="var(--color-accent)"
      maskStrokeWidth={1.5}
      pannable
      zoomable
    />
  </SvelteFlow>
</div>

<style>
  /*
   * Elevate the minimap so it reads against the dark dot pattern
   * (Pencil node `BWzPi` "Minimap"). The upstream stylesheet hard-codes
   * a white background with a faint box-shadow; both are invisible on
   * the FlowCraft canvas.
   */
  .flowcraft-canvas :global(.svelte-flow__minimap) {
    background-color: var(--color-bg-elevated);
    border: 1px solid var(--color-border-default);
    border-radius: 8px;
    opacity: 0.85;
    overflow: hidden;
  }

  /* The viewport rectangle in the design (Pencil `tX2EP`) is an outline-only
     accent stroke — no fill mask. We achieve that by rendering the mask
     transparently (set above via the `maskColor` prop) and styling the path
     as an accent outline. */
  .flowcraft-canvas :global(.svelte-flow__minimap-mask) {
    fill: transparent;
    stroke: var(--color-accent);
    stroke-width: 1.5;
  }

  /*
   * Edge styling. Default xyflow edges are 1px black; the design uses a
   * 2px `border-strong` stroke (Pencil `XOjVs`). Hover / selected states
   * promote the stroke to the FlowCraft accent so the user can see which
   * edge they are about to interact with.
   */
  .flowcraft-canvas :global(.svelte-flow__edge-path) {
    stroke: var(--color-border-strong);
    stroke-width: 2;
  }

  .flowcraft-canvas :global(.svelte-flow__edge.selected .svelte-flow__edge-path),
  .flowcraft-canvas :global(.svelte-flow__edge:hover .svelte-flow__edge-path) {
    stroke: var(--color-accent);
  }

  .flowcraft-canvas :global(.svelte-flow__connectionline) {
    stroke: var(--color-accent);
    stroke-width: 2;
  }

  /*
   * The default xyflow node has its own border + background which would
   * render behind our custom card. Strip it so only the WorkflowNode
   * surface shows.
   */
  .flowcraft-canvas :global(.svelte-flow__node-default) {
    background: transparent;
    border: none;
    padding: 0;
    width: auto;
  }

  /*
   * Suppress xyflow's stock blue dashed selection outline on the wrapping
   * node element — `WorkflowNode.svelte` renders its own accent ring on the
   * inner card so the selection cue stays on-palette (review note P1).
   */
  .flowcraft-canvas :global(.svelte-flow__node.selected) {
    outline: none;
    box-shadow: none;
  }
  .flowcraft-canvas :global(.svelte-flow__node.selected .svelte-flow__node-default) {
    outline: none;
    box-shadow: none;
  }

  /*
   * Cursor feedback for the canvas tool selector. In `hand` mode the pane
   * shows a `grab` cursor; in `select` mode we keep the default arrow so
   * the marquee selection feels familiar.
   */
  .flowcraft-canvas[data-canvas-mode='hand'] :global(.svelte-flow__pane) {
    cursor: grab;
  }
  .flowcraft-canvas[data-canvas-mode='hand'] :global(.svelte-flow__pane.dragging) {
    cursor: grabbing;
  }
</style>
