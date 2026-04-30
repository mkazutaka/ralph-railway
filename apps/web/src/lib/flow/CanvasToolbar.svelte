<!--
  Canvas Toolbar mirroring `apps/web/design/app.pen` node `gskMk`
  ("Canvas Toolbar"). A horizontal pill anchored to the top-center of the
  canvas with two interaction-mode buttons:

    - Select Tool (cursor): left-click drags a marquee selection, right /
      middle mouse pans the canvas. Matches Figma / Sketch defaults.
      Keyboard shortcut: V.
    - Hand Tool: left-click pans the canvas; nothing is selected. Keyboard
      shortcut: H.

  Visual contract:
    - 40px tall, 8px corner radius, `bg-elevated` fill with `border-default`
      stroke and a soft drop shadow (Pencil node `gskMk` effect:
      `#00000040`, blur 12, offset y4 — surfaced via the
      `--color-shadow-toolbar` token, which is intentionally lighter than
      `--color-shadow-elevated` used by the deeper popover surface).
    - Each tool slot is 34×32 with a 6px corner radius. The active slot uses
      `bg-active` (a distinct swatch slightly heavier than `bg-hover`, see
      `app.css`) and `text-primary`; inactive slots use `text-secondary` and
      hover to `bg-hover` so the active state stays unambiguous even while
      the user hovers an adjacent tool.
    - Lucide icons at 16px.

  We deliberately do NOT render the design's Comment / Sticky Note / Undo /
  Redo slots in this scenario: the underlying behaviours (annotations,
  per-edit history) are not implemented elsewhere in the editor today, and
  shipping non-functional buttons violates the "no fake placeholders"
  contract from `docs/tasks/implement-design-plan.md`. The two tools below
  ARE wired to real Svelte Flow behaviours (`panOnDrag` / `selectionOnDrag`)
  so each click produces a visible canvas-mode change.

  Component contract: a single `mode` prop (string union, two-way bound)
  drives both the active visual state and the SvelteFlow pan/select wiring
  in `Graph.svelte`. The parent owns the state so future scenarios can
  mutate the same source of truth without prop-drilling.
-->
<script lang="ts" module>
  // `module`-scoped so the type is exportable for `Graph.svelte`'s
  // `bind:mode` binding without triggering Svelte 5's "non-instance export
  // from instance script" warning.
  export type CanvasMode = 'select' | 'hand';
</script>

<script lang="ts">
  import MousePointer from 'lucide-svelte/icons/mouse-pointer';
  import Hand from 'lucide-svelte/icons/hand';

  let { mode = $bindable('select') }: { mode: CanvasMode } = $props();

  const tools: ReadonlyArray<{
    id: CanvasMode;
    label: string;
    shortcut: string;
    Icon: typeof MousePointer;
  }> = [
    {
      id: 'select',
      label: 'Select tool — drag to marquee-select',
      shortcut: 'V',
      Icon: MousePointer,
    },
    {
      id: 'hand',
      label: 'Hand tool — drag to pan the canvas',
      shortcut: 'H',
      Icon: Hand,
    },
  ];

  /**
   * Keyboard shortcut handler. Matches Figma's `V` / `H` convention. We
   * scope it to the document so the shortcut works regardless of where the
   * focus is on the canvas pane (xyflow's pane element doesn't naturally
   * accept focus). When the user is typing in a textarea / input we bow
   * out so the shortcut doesn't steal their keystroke.
   */
  function handleKeydown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
    }
    const key = event.key.toLowerCase();
    if (key === 'v') {
      mode = 'select';
      event.preventDefault();
    } else if (key === 'h') {
      mode = 'hand';
      event.preventDefault();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="flex items-center gap-0.5 rounded-lg border border-(--color-border-default) bg-(--color-bg-elevated) px-1 py-1 shadow-[0_4px_12px_var(--color-shadow-toolbar)]"
  role="toolbar"
  aria-label="Canvas tools"
>
  {#each tools as tool (tool.id)}
    {@const active = mode === tool.id}
    <button
      type="button"
      aria-label="{tool.label} ({tool.shortcut})"
      aria-pressed={active}
      title="{tool.label} ({tool.shortcut})"
      onclick={() => (mode = tool.id)}
      class="flex h-8 w-[34px] items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-(--color-accent) {active
        ? 'bg-(--color-bg-active) text-(--color-text-primary)'
        : 'text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)'}"
    >
      <tool.Icon class="h-4 w-4" aria-hidden="true" />
    </button>
  {/each}
</div>
