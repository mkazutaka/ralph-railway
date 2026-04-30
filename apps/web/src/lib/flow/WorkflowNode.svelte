<!--
  Custom Svelte Flow node mirroring the FlowCraft canvas design at
  `apps/web/design/app.pen` (frame `EbnDF` "Canvas Area"; nodes `DN7Za`,
  `bsZWB`, `MJ0Jp`, `QwOaB`; loop container `yr3GN`).

  Visual contract:
    - Default ("step") variant: 180×68 elevated card with `radius-lg` corners,
      4px coloured stripe on the left (`RxVuw` / `kTjoR`), 20px Lucide icon,
      `Inter` 13/600 title + 11 subtitle, optional 6px status dot at top-right
      (`ZryXu`).
    - Loop ("for") variant: 370px-wide `bg-surface` container with a 1.5px
      accent border (`yr3GN`). It carries a header row (icon + title +
      subtitle + "N steps" badge) and a footer "loop back until …" hint.
      Body steps are not nested as real children inside this node — they are
      sibling nodes in the flow graph laid out around it. The container
      surface is rendered to give the user a visual anchor that matches the
      design's enclosing frame.
    - Source / target handles styled as 12px circles with a 2px
      `border-strong` border + a 4px inner dot tinted by category, matching
      Pencil `qtfr8` / `tcDkV` / `x09sv` / `tcnFT`.

  We map the YAML task kinds (`set` / `call` / `run` / `for` / `switch` /
  `fork` / `try` / `do`) onto the design's node category tints so users
  see at a glance whether a step is a trigger, an action, a control-flow
  branch, etc. The mapping lives here (not in `to-flow.ts`) because the
  graph adapter is shared with non-visual consumers; the visual category
  is a pure rendering concern.
-->
<script lang="ts">
  import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';
  import Play from 'lucide-svelte/icons/play';
  import Terminal from 'lucide-svelte/icons/terminal';
  import Variable from 'lucide-svelte/icons/variable';
  import Repeat from 'lucide-svelte/icons/repeat';
  import GitBranch from 'lucide-svelte/icons/git-branch';
  import GitFork from 'lucide-svelte/icons/git-fork';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import Layers from 'lucide-svelte/icons/layers';
  import Box from 'lucide-svelte/icons/box';
  import CornerDownLeft from 'lucide-svelte/icons/corner-down-left';

  type Category = 'trigger' | 'action' | 'logic' | 'ai' | 'output';
  type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  // The DOM-projected status — same as RunStatus plus `'idle'` for nodes
  // without a per-node run result yet. Used by E2E tests via `data-status`.
  type DomStatus = RunStatus | 'idle';

  /**
   * Per-node data the FlowGraph adapter (`from-dto.ts` / `to-flow.ts`) hands us.
   * `label` and `kind` are guaranteed at adapter level; `status` is optional and
   * only present once per-node run state lands in the data layer (today the
   * status indicator simply stays hidden when missing). The shape extends
   * xyflow's data record so it can flow through `Node<...>` without a cast.
   */
  type WorkflowNodeData = Record<string, unknown> & {
    label?: string;
    kind?: string;
    status?: RunStatus;
    /**
     * Loop body step count. Populated by the YAML adapter (`to-flow.ts`)
     * for `kind === 'for'` tasks. When missing the loop badge falls back
     * to the static caption `loop` so the server-rendered initial view
     * (which routes through `from-dto.ts` and does not carry loop body
     * shape) still renders without `undefined` glyphs.
     */
    bodyStepCount?: number;
    /**
     * Loop exit condition expression for the `for` variant footer. Populated
     * by the YAML adapter from the task's `until` / `while` clause. When
     * missing the footer falls back to the generic `loop body` caption.
     */
    until?: string;
  };
  type WorkflowNode = Node<WorkflowNodeData>;

  // Map a YAML task `kind` to a visual category (matches the node-tint
  // tokens in `app.css`). Unknown kinds fall back to `output` so the
  // node still renders with a neutral-but-visible stripe rather than a
  // silent-fail invisible bar.
  function categoryFor(kind: string): Category {
    switch (kind) {
      case 'run':
        return 'trigger';
      case 'call':
        return 'ai';
      case 'set':
        return 'action';
      case 'for':
      case 'switch':
      case 'fork':
      case 'try':
        return 'logic';
      case 'do':
        return 'output';
      default:
        return 'output';
    }
  }

  // Pick a Lucide icon for the kind — mirrors the icons used in the
  // design's node cards (Play / Terminal) and the Pattern Showcase
  // frame (`Y2aOxm`) for the control-flow patterns. `git-fork` matches the
  // Pencil icon (`Y2j6pa`/`k6Y5G`).
  function iconFor(kind: string): typeof Play {
    switch (kind) {
      case 'run':
        return Play;
      case 'call':
        return Terminal;
      case 'set':
        return Variable;
      case 'for':
        return Repeat;
      case 'switch':
        return GitBranch;
      case 'fork':
        return GitFork;
      case 'try':
        return ShieldAlert;
      case 'do':
        return Layers;
      default:
        return Box;
    }
  }

  // Short human label for the subtitle. The design's nodes show a
  // descriptive subtitle (e.g. "way nextjs-todo", "npx create-next-app");
  // we don't have access to that metadata yet, so we surface the YAML
  // task `kind` formatted as a small caption ("trigger · run").
  function subtitleFor(kind: string, category: Category): string {
    if (kind === 'unknown') return 'unknown step';
    return `${category} · ${kind}`;
  }

  // Structured tint table — keeping `stripeBg`, `iconText`, `dotBg` as
  // separate static class strings keeps Tailwind's JIT able to extract them
  // without runtime string interpolation, and avoids the brittle
  // `tintClass.split(' ')` indexing the previous revision relied on.
  const TINTS: Readonly<
    Record<Category, { stripeBg: string; iconText: string; dotBg: string }>
  > = {
    trigger: {
      stripeBg: 'bg-(--color-node-trigger)',
      iconText: 'text-(--color-node-trigger)',
      dotBg: 'bg-(--color-node-trigger)',
    },
    action: {
      stripeBg: 'bg-(--color-node-action)',
      iconText: 'text-(--color-node-action)',
      dotBg: 'bg-(--color-node-action)',
    },
    logic: {
      stripeBg: 'bg-(--color-node-logic)',
      iconText: 'text-(--color-node-logic)',
      dotBg: 'bg-(--color-node-logic)',
    },
    ai: {
      stripeBg: 'bg-(--color-node-ai)',
      iconText: 'text-(--color-node-ai)',
      dotBg: 'bg-(--color-node-ai)',
    },
    output: {
      // Mirrors the design's `$node-output` token (Pencil
      // `EbnDF/BWzPi/VvXiW` and `DMmQr` minimap mini-rectangles, plus the
      // `Card: do (block)` showcase). Previously fell back to
      // `--color-text-tertiary` which read as "secondary / disabled" rather
      // than as an output-category swatch (review note frontend #1).
      stripeBg: 'bg-(--color-node-output)',
      iconText: 'text-(--color-node-output)',
      dotBg: 'bg-(--color-node-output)',
    },
  };

  // Map a per-node run status to the status-dot tint. `pending` and
  // `skipped` deliberately render no dot (`null`) so the card surface stays
  // clean for un-run nodes — the design's success-green dot was previously
  // hard-coded and produced false-positive "succeeded" semantics on every
  // node regardless of run state.
  function statusDotClass(status: RunStatus | undefined): string | null {
    switch (status) {
      case 'succeeded':
        return 'bg-(--color-success)';
      case 'failed':
        return 'bg-(--color-danger)';
      case 'running':
        return 'bg-(--color-accent) animate-pulse';
      case 'cancelled':
        return 'bg-(--color-text-tertiary)';
      default:
        return null;
    }
  }

  let { data, selected }: NodeProps<WorkflowNode> = $props();

  // `data` is typed as `Record<string, unknown>` per xyflow's generic, so we
  // narrow defensively to the keys our adapter sets (`label` / `kind` /
  // optional `status`). The runtime checks keep TypeScript happy without
  // forcing a cast or a dependency on a runtime schema validator.
  const label = $derived(typeof data?.label === 'string' ? (data.label as string) : '');
  const kind = $derived(typeof data?.kind === 'string' ? (data.kind as string) : 'unknown');
  const category = $derived(categoryFor(kind));
  const Icon = $derived(iconFor(kind));
  const subtitle = $derived(subtitleFor(kind, category));
  const tint = $derived(TINTS[category]);
  // Normalise the per-node run status to a known string (or `'idle'` when
  // missing) so we can surface it as a `data-status` attribute on the outer
  // card. The attribute is the only way for E2E tests to assert that
  // per-node execution state has projected onto the canvas — the dot itself
  // is `aria-hidden` and the colour-only cue cannot be read by Playwright
  // without coupling to CSS class names (review note Major-4).
  const status = $derived<DomStatus>(
    typeof data?.status === 'string' ? (data.status as RunStatus) : 'idle',
  );
  const statusDot = $derived(statusDotClass(status === 'idle' ? undefined : status));

  // Card vs. loop-container layout. The `for` kind expands into the design's
  // Loop Container (`yr3GN`) — wider, surface-coloured, accent-bordered, with
  // a header row and a "loop back" footer. All other kinds keep the standard
  // 180×68 step card.
  const isLoop = $derived(kind === 'for');

  // Loop badge text (Pencil `YR65n`). Pluralises "step" so the badge reads
  // "1 step" / "2 steps", matching the design's example caption (`RcfHP`
  // "2 steps"). When the YAML adapter could not surface a body count
  // (server-rendered initial view, malformed `for: do:`), fall back to a
  // static `loop` caption so the badge still renders.
  const bodyStepCount = $derived(
    typeof data?.bodyStepCount === 'number' && Number.isFinite(data.bodyStepCount)
      ? (data.bodyStepCount as number)
      : null,
  );
  const loopBadgeLabel = $derived(
    bodyStepCount !== null
      ? `${bodyStepCount} step${bodyStepCount === 1 ? '' : 's'}`
      : 'loop',
  );

  // Loop footer text (Pencil `OrLXv` "loop back until APPROVED"). The until
  // expression is extracted by the YAML adapter; when missing we fall back
  // to a generic `loop body` so the footer is never empty.
  const untilExpr = $derived(
    typeof data?.until === 'string' && data.until.length > 0
      ? (data.until as string)
      : null,
  );
  const loopFooterLabel = $derived(untilExpr !== null ? `loop back until ${untilExpr}` : 'loop body');

  // Selection ring. xyflow's stock `.selected` styling is a blue dashed
  // outline that clashes with the FlowCraft accent palette — we suppress it
  // globally in `Graph.svelte` and re-apply our own accent ring here so
  // selected nodes read correctly against the dot background.
  //
  // The selected state is also surfaced as `data-selected` on the outer card
  // so E2E tests can observe selection without coupling to the CSS class
  // string (review note Major-3). We deliberately do NOT use `aria-selected`
  // here because the wrapper carries `role="group"`, and `aria-selected` is
  // not in the supported aria-attributes set for that role; downgrading to a
  // data attribute keeps the assertion testable while passing the
  // svelte-check a11y lints.
  const ringClass = $derived(
    selected ? 'ring-2 ring-(--color-accent) ring-offset-0' : '',
  );

  // Handle wrappers: an outer 12px circle (matches `qtfr8` / `x09sv`) plus a
  // 4px inner dot tinted by category (matches `tcDkV` / `tcnFT` / `W8jQ8`).
  // We use absolute positioning for the inner dot so the xyflow handle's own
  // `left` / `right` placement keeps working.
  //
  // The canvas is read-only (`Graph.svelte` pins `nodesConnectable={false}`),
  // so the `.connecting` upgrade fires only as latent affordance for a future
  // editable mode and the handles are decorative for the user. We still keep
  // them in the DOM so xyflow can route edges to/from the centre of each
  // node, but `pointer-events-none` keeps them from accepting hover/focus
  // events that would lead nowhere (review notes P1-3 / P2-2).
  const handleSurfaceBase =
    'pointer-events-none !h-3 !w-3 !border-2 !bg-(--color-bg-elevated) [&.connecting]:!h-[22px] [&.connecting]:!w-[22px] [&.connecting]:!border-0 [&.connecting]:!bg-(--color-accent) [&.connecting]:shadow-[0_0_10px_var(--color-accent-shadow)]';

  // The design's `RmNLc` ("handle: Loop input") variant uses a 2px accent
  // border on the target handle when the parent step is the focus of an
  // active connection. The canvas is read-only today so we project the
  // same affordance off the `selected` flag — when the user picks a node
  // in the canvas, its target handle border promotes to accent so the
  // upstream edge endpoint is unmistakable. The source handle keeps the
  // strong-border tint so the two endpoints remain distinguishable.
  const targetHandleClass = $derived(
    `${handleSurfaceBase} ${selected ? '!border-(--color-accent)' : '!border-(--color-border-strong)'}`,
  );
  const sourceHandleClass = `${handleSurfaceBase} !border-(--color-border-strong)`;
</script>

{#if isLoop}
  <!--
    Loop Container variant (`yr3GN`). 370px wide, surface fill, 1.5px accent
    border, 12px corner radius. We render the header row + footer hint inline.
    The body steps live as separate flow nodes — the container surface here is
    the visual anchor only.
  -->
  <div
    class="relative flex w-[370px] flex-col rounded-xl border-[1.5px] border-(--color-accent) bg-(--color-bg-surface) {ringClass}"
    role="group"
    aria-label="{kind} step: {label}"
    data-selected={selected}
    data-status={status}
  >
    <!-- Header (`z1MFI`): icon + title/subtitle on the left, "N steps" badge on the right. -->
    <div class="flex items-center justify-between gap-2.5 px-3.5 py-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <Icon class="h-[18px] w-[18px] shrink-0 text-(--color-accent)" aria-hidden="true" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[13px] leading-tight font-semibold text-(--color-text-primary)"
            >{label}</span
          >
          <span class="truncate text-[11px] leading-tight text-(--color-text-secondary)"
            >{subtitle}</span
          >
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <!--
          Loop body step badge (Pencil `YR65n` "2 steps"). The label is
          data-driven via `bodyStepCount` (review note FE-2): the previous
          revision hard-coded the string "loop", which dropped the design's
          dynamic step-count signal. When the adapter could not surface a
          count (server-rendered initial view) the label falls back to
          "loop" so the badge still renders.

          Status dot was deliberately removed from the loop variant to match
          the design (`yr3GN` carries no status dot — only the step-card
          variant `ZryXu` does). E2E observers still read per-node status via
          `data-status` on the outer container (set below).
        -->
        <span
          class="rounded-full bg-(--color-accent-muted) px-2 py-0.5 text-[10px] font-medium text-(--color-accent)"
          aria-label="Loop body steps"
        >
          {loopBadgeLabel}
        </span>
      </div>
    </div>

    <!-- Footer hint (`rgIgJ`): "loop back until …". Drives off `until` so
         the design's exit-condition signal lands in the UI (review note
         FE-3). Falls back to a generic `loop body` caption when no
         expression was provided. -->
    <div
      class="flex items-center justify-center gap-1.5 px-3.5 pt-1 pb-3 text-(--color-text-tertiary)"
    >
      <CornerDownLeft class="h-3 w-3 shrink-0" aria-hidden="true" />
      <span class="text-[11px] leading-none">{loopFooterLabel}</span>
    </div>

    <Handle
      type="target"
      position={Position.Left}
      class={targetHandleClass}
      aria-label="Target handle"
    />
    <Handle
      type="source"
      position={Position.Right}
      class={sourceHandleClass}
      aria-label="Source handle"
    />
  </div>
{:else}
  <!--
    Outer card: matches the design's 180×68 surface with the elevated fill
    and a 1px default border. We declare the height explicitly so handles
    align to the vertical centre regardless of label length (the design
    treats the card as fixed-height; long labels truncate via `truncate`
    on the inner text spans).

    `overflow-hidden` was previously applied here so the 4px coloured stripe
    would round into the card's `rounded-lg` corners. xyflow's `<Handle>`
    elements are absolutely positioned half-outside the card border (12px
    circles at `left:0` / `right:0`), so the clipping was hiding them
    entirely — the design (`apps/web/design/app.pen`, `qtfr8` / `x09sv`)
    expects the handle circles to straddle the border. We instead push the
    stripe rounding into the stripe element itself
    (`rounded-l-lg`) so the parent can stay `overflow-visible` and the
    handles can render outside the card edge (review note frontend #2).
  -->
  <div
    class="relative flex h-[68px] w-[180px] items-stretch rounded-lg border border-(--color-border-default) bg-(--color-bg-elevated) {ringClass}"
    role="group"
    aria-label="{kind} step: {label}"
    data-selected={selected}
    data-status={status}
  >
    <!-- 4px coloured stripe (Pencil node `RxVuw` / `kTjoR`). The
         `rounded-l-lg` matches the parent's left corners since the parent
         no longer clips overflow (see comment above). -->
    <div class="w-1 shrink-0 rounded-l-lg {tint.stripeBg}" aria-hidden="true"></div>

    <div class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
      <Icon class="h-5 w-5 shrink-0 {tint.iconText}" aria-hidden="true" />
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-[13px] leading-tight font-semibold text-(--color-text-primary)"
          >{label}</span
        >
        <span class="truncate text-[11px] leading-tight text-(--color-text-secondary)">{subtitle}</span>
      </div>
    </div>

    <!-- Status dot (Pencil node `ZryXu`). Only rendered when the data layer
         provides a real status — otherwise the surface stays clean instead
         of advertising a false "succeeded" green dot. -->
    {#if statusDot}
      <!--
        Status dot position matches the design (`ZryXu` x=166, y=8 within a
        180-wide card — i.e. 6px from the right edge / 8px from the top).
        `right-1.5` (6px) hits the design value exactly; the previous
        `right-2` (8px) was 2px off (review note nice-to-have).
      -->
      <span
        class="pointer-events-none absolute top-2 right-1.5 h-1.5 w-1.5 rounded-full {statusDot}"
        aria-hidden="true"
      ></span>
    {/if}

    <!-- Connection handles (Pencil nodes `qtfr8` / `x09sv`). The inner 4px
         tint dot (`tcDkV`/`tcnFT`/`W8jQ8`) is rendered as a sibling so it
         sits centred over the handle without breaking xyflow's hit-target.
         The target handle promotes to an accent border on `selected`
         (matches the `RmNLc` ACTIVE variant in the design). -->
    <Handle
      type="target"
      position={Position.Left}
      class={targetHandleClass}
      aria-label="Target handle"
    />
    <span
      class="pointer-events-none absolute top-1/2 left-0 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full {tint.dotBg}"
      aria-hidden="true"
    ></span>
    <Handle
      type="source"
      position={Position.Right}
      class={sourceHandleClass}
      aria-label="Source handle"
    />
    <span
      class="pointer-events-none absolute top-1/2 right-0 h-1 w-1 translate-x-1/2 -translate-y-1/2 rounded-full {tint.dotBg}"
      aria-hidden="true"
    ></span>
  </div>
{/if}
