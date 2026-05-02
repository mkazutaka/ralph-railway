<!--
  Persistent application top bar.

  Mirrors the `Ht9Do` "Top Bar" frame in `apps/web/design/app.pen`:

      ┌───────────────────────────────────────────────────────────────┐
      │ ▢ Ralph Railway │ .agents/railways / nextjs-todo.yaml         │
      │                       ● Saved                  ⏵ Run  ⚙ … MK │
      └───────────────────────────────────────────────────────────────┘

  The 56px height, 20px horizontal padding, `bg-topbar` fill and the
  bottom 1px `border-topbar` rule come straight from the design tokens
  defined in `apps/web/src/app.css`. We use the dedicated TopBar tokens
  (`--color-bg-topbar` / `--color-border-topbar`) rather than the generic
  `--color-bg-surface` / `--color-border-subtle` because the design's
  light-theme Top Bar (`hcjon`) is `#FAFAFA` over `#FFFFFF` cards and the
  bottom hairline is `#EFEFF1` (lighter than the generic subtle border).
  Sharing tokens with cards/sidebar would have flattened that hierarchy
  on light theme (review-design-topbar-frontend.md M-1 / M-2). On dark
  the TopBar tokens alias the Pencil values verbatim.

  The bar is structurally split into three columns matching the design
  groups (`cqoiY` left, `kBLMd` center, `sVMX2` right):

    - Left  : mobile drawer trigger + brand + breadcrumb (`flex-1`)
    - Center: ambient state pill (`Saved`)              (`shrink-0`)
    - Right : icon affordances (History/Settings/Share) + Run button
              + user avatar                             (`shrink-0`)

  Save / Run wiring: the workflow editor route (`/workflows/[id]`)
  registers a `TopBarEditorBinding` via `topBarContext.svelte.ts`. When a
  binding is present, the bar surfaces the Save trigger, the live save
  status pill, and the accent Run button. Otherwise the bar shows only
  the chrome (the index route and the "new workflow" route have nothing
  to save or run, so we collapse those controls rather than render
  permanently-disabled buttons that would mis-cue the user).

  Save / Run components are reused unchanged from the editor feature
  (`SaveButton`, `RunWorkflowButton`) so any change to those affordances
  flows through to both surfaces.

  Coming-soon affordances (History / Settings / Share): rendered as
  native `<button disabled>` with `title="Coming soon"` plus an
  sr-only suffix on the accessible name. We keep the design's chrome
  visible without the AT/HTML disabled mismatch that `aria-disabled`
  alone would produce — `disabled` strips the focus and click paths
  consistently across pointer, keyboard, and assistive tech (review
  note frontend S-1). Replacing `disabled` with the future scenario's
  `onclick` handler activates the affordance without any other
  markup churn.

  Layout guard: Left column owns the flex-grow (`flex-1` + `min-w-0`)
  so its breadcrumb is the only segment that ever truncates; Center +
  Right are `shrink-0` so the Saved pill and Save/Run cluster never
  collapse in mid-width viewports (review note frontend M-1, M-4).
-->
<script lang="ts">
  import { page } from '$app/state';
  import TrainFront from 'lucide-svelte/icons/train-front';
  import History from 'lucide-svelte/icons/history';
  import Settings from 'lucide-svelte/icons/settings';
  import Share2 from 'lucide-svelte/icons/share-2';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import TriangleAlert from 'lucide-svelte/icons/triangle-alert';
  import type { WorkflowSummaryDto } from '$features/workflow-editor/entities/dto';
  import MobileSidebarDrawer from './MobileSidebarDrawer.svelte';
  import SaveButton from '$lib/components/save-button.svelte';
  import RunWorkflowButton from '$features/workflow-editor/components/RunWorkflowButton.svelte';
  import { topBarCopy as copy } from './topBarCopy';
  import { getTopBarEditor } from './topBarContext.svelte';
  import { editorCopy } from '$features/workflow-editor/lib/editorCopy';

  let {
    workflows,
  }: {
    /**
     * Workflow list passed through to the mobile drawer. The drawer is
     * only mounted (`< lg`) when the desktop sidebar is hidden, so the
     * Top Bar takes the same layout payload the sidebar consumes and
     * forwards it. Keeping the prop on the bar avoids duplicate
     * `+layout.server.ts` reads.
     */
    workflows: ReadonlyArray<WorkflowSummaryDto>;
  } = $props();

  /**
   * Active workflow id, derived from the route. Pulling this from
   * `page.params.id` (rather than `page.data`) keeps the bar working
   * even on routes whose load functions don't expose the id, and
   * mirrors the route shape the breadcrumb is derived from.
   *
   * The id is the full filename (e.g. `nextjs-todo.yaml`) because the
   * server's WorkflowId brand allow-lists the `.yaml` / `.yml` suffix
   * (see `entities/workflowSummary.ts`); the design's breadcrumb shows
   * the file under `.agents/railways`, which matches this shape exactly.
   */
  const workflowId = $derived<string | null>(page.params.id ?? null);

  /**
   * Editor binding from the workflow editor route. `null` on routes
   * that have no editor mounted — the bar collapses Save/Run/Pill in
   * that case.
   *
   * Reading via `getTopBarEditor()` (the null-safe reader) inside a
   * `$derived` keeps the bar resilient to mount-order surprises: the
   * holder install lives in `+layout.svelte`, but if a route ever
   * renders the bar before the layout's `provideTopBarEditorHolder()`
   * has run (or outside the shell entirely, e.g. in isolated tests),
   * the throwing variant `getTopBarEditorHolder()` would crash the
   * whole tree.
   */
  const editor = $derived(getTopBarEditor());
</script>

<!--
  `header` so the bar shows up as a banner landmark in screen-reader
  rotor lists. Height + horizontal padding mirror the design (`56`,
  `[0,20]`), with `shrink-0` so the bar never collapses when the body
  flex container compresses on short viewports.

  `flex-nowrap` + `whitespace-nowrap` on the wordmark / breadcrumb /
  share label below preserves the `Ht9Do` `height: 56` invariant — a
  single 56px row at every viewport.
-->
<header
  class="flex h-14 shrink-0 flex-nowrap items-center gap-3 border-b border-(--color-border-topbar) bg-(--color-bg-topbar) px-5"
  aria-label={copy.bannerAria}
>
  <!--
    Mobile-only drawer trigger. Sits before the brand mark so screen
    readers and keyboard users encounter navigation first when the
    desktop sidebar is collapsed. `lg:hidden` lives inside the drawer
    component itself so the toggle disappears once the persistent
    `<aside>` takes over.
  -->
  <MobileSidebarDrawer {workflows} />

  <!--
    Brand + breadcrumb (`cqoiY` "TopBar Left" in the design). Owns the
    flex-grow — the Center pill and Right rail stay `shrink-0`, so when
    the breadcrumb runs out of room it is the *only* segment that
    truncates. Mirrors the design's intent that the Saved pill stays
    visible at every viewport that renders it (review note M-1, M-4).
  -->
  <div class="flex min-w-0 flex-1 items-center gap-3">
    <a
      href="/"
      class="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-bg-topbar) focus-visible:outline-none"
      aria-label={copy.brandAria}
    >
      <!--
        Logo glyph. The design uses a linear gradient from `$accent`
        to `#8B5CF6`; we recreate it via `bg-gradient-to-br` so the
        swatch stays in sync with the accent token across both dark
        and light themes.
      -->
      <span
        class="flex size-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-(--color-accent) to-violet-500"
        aria-hidden="true"
      >
        <TrainFront class="size-4 text-white" aria-hidden="true" />
      </span>
      <!--
        Wordmark is hidden < sm so the right rail (Save + Run + drawer
        trigger + avatar) keeps room on phone-sized viewports (375 px is
        the design's minimum). The brand glyph alone still carries the
        navigation + brand semantics, and the link's `aria-label`
        ("Ralph Railway home") preserves the accessible name for screen
        readers. `whitespace-nowrap` keeps the two-word wordmark on a
        single line at every viewport that does render it.
      -->
      <span
        class="hidden text-[15px] leading-none font-semibold whitespace-nowrap text-(--color-text-primary) sm:inline"
      >
        {copy.brand}
      </span>
    </a>

    <!--
      Vertical divider mirrors the design's `Nxp4R` 1×20 rectangle.
      Pencil binds the divider to `$border-default` (Dark `#383848` /
      Light `#e4e4e7`), one tier heavier than the bar's bottom 1px
      hairline (`$border-subtle` → `--color-border-topbar`). The design
      intentionally splits hairlines into two layers so the vertical
      separators read between the breadcrumb segments and don't fade
      into the bottom rule. Routing this through
      `--color-border-default` restores the design's
      $border-subtle (bottom rule) ↔ $border-default (divider / Share
      stroke) contrast in both themes (review note frontend M-A).

      Hidden on narrow viewports where the breadcrumb collapses, and
      also hidden when no workflow is open — without a breadcrumb the
      divider would dangle next to the brand mark with nothing to
      separate.
    -->
    {#if workflowId}
      <span
        class="hidden h-5 w-px bg-(--color-border-default) sm:block"
        aria-hidden="true"
      ></span>
    {/if}

    <!--
      Breadcrumb. Hidden on the narrowest viewports (mobile) so the
      brand mark and right-rail controls keep their breathing room;
      reappears at `sm:` where there is enough horizontal space.

      Rendered only when a workflow is open. The design (`m8qlI` in
      `apps/web/design/app.pen`) consistently pairs the
      `.agents/railways` root with a workflow filename, and never draws
      the root by itself. On the index / new-workflow routes we collapse
      the breadcrumb entirely so the Top Bar Left does not look
      truncated with a single dangling segment. The brand link already
      carries the home affordance.
    -->
    {#if workflowId}
      <!--
        Breadcrumb structured as `<nav><ol><li>` per the WAI-ARIA
        breadcrumb pattern: the leaf segment carries
        `aria-current="page"` so AT users hear "current page" alongside
        the workflow filename, instead of a bare `<span>` chain (review
        note frontend L-7). `overflow-hidden` on the `<ol>` guarantees
        the `truncate` on the leaf's `<span>` activates even when the
        outer flex column has not yet collapsed to its `min-w-0`
        constraint (review note frontend M-5).
      -->
      <nav
        class="hidden min-w-0 items-center text-[13px] sm:flex"
        aria-label="Breadcrumb"
      >
        <ol class="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <li class="whitespace-nowrap text-(--color-text-tertiary)">
            {copy.breadcrumbRoot}
          </li>
          <li class="text-(--color-text-tertiary)" aria-hidden="true">
            {copy.breadcrumbSeparator}
          </li>
          <!--
            Workflow segment. The id is already the filename including its
            `.yaml`/`.yml` suffix (the WorkflowId brand validates the
            extension at the repository boundary), so it slots straight
            into the design's `nextjs-todo.yaml` cell without further
            formatting.

            Truncation cap scales with viewport: 24ch on `sm`, 40ch on
            `md`, 56ch on `lg+`. The previous flat `40ch` cap pushed the
            Saved pill off-screen at `sm` (review note frontend M-4). The
            `min-w-0 truncate` chain still ellipses gracefully inside
            whichever cap is active. `title={workflowId}` exposes the
            full filename as a native browser tooltip for users who hit
            the truncation cap, so a long name is still discoverable
            without resizing the viewport (review note frontend M-5).
          -->
          <li
            class="block min-w-0 max-w-[24ch] truncate font-medium text-(--color-text-secondary) md:max-w-[40ch] lg:max-w-[56ch]"
            aria-current="page"
            title={workflowId}
          >
            {workflowId}
          </li>
        </ol>
      </nav>
    {/if}
  </div>

  <!--
    Center column (`kBLMd` in the design). The design pairs two pills
    here: a Status Badge (`iCDRl`, mirrored below as the save-status
    pill) and a Version Tag (`pBpzN`, e.g. `v2.4`). Only the Status
    Badge is wired today — the workflow repository / API does not yet
    expose a version field, so surfacing a hard-coded `v2.4` would
    misrepresent reality (review note frontend M-2). The Version Tag
    will land alongside the version-tracking scenario; until then the
    center column houses the save-status pill alone.

    Save-status pill: rendered only when an editor is mounted;
    otherwise the column collapses entirely and the right rail butts
    up against the breadcrumb (`sVMX2` keeps its trailing edge via
    `ml-auto` on the wrapper).

    `shrink-0` so the pill never collapses; the Left column is the
    only segment that flexes (review note M-1).
  -->
  {#if editor}
    <div
      class="hidden shrink-0 items-center justify-center sm:flex"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={copy.saveStatusAria}
      data-testid="topbar-save-status"
    >
      {#if editor.saveStatus === 'saving'}
        <!--
          Saving variant uses the design's neutral `$bg-hover` swatch +
          secondary text colour so the in-flight state reads as a
          transient ambient pill, not as a Run-accent affordance.
          Pencil's `iCDRl` Status Badge does not define a `Saving`
          variant; the previous accent-muted tint risked being misread
          as "Run in progress". Keeping the same dot/spinner layout
          ensures the pill still signals motion against the static
          `Saved` and `Save failed` variants.
        -->
        <span
          class="flex items-center gap-1.5 rounded-full bg-(--color-bg-hover) px-2.5 py-1 text-xs font-medium text-(--color-text-secondary)"
          data-testid="topbar-save-status-saving"
        >
          <LoaderCircle class="size-3 animate-spin" aria-hidden="true" />
          <span>{copy.savingLabel}</span>
        </span>
      {:else if editor.saveStatus === 'saved'}
        <!--
          "Saved" pill mirrors `iCDRl` exactly: a 6px `$success` dot
          (`XPXXZ` in the design) followed by the label, both wrapped
          in a `bg-(--color-success-muted)` pill with `padding: [4,10]`.
          The dot is decorative, so it stays `aria-hidden="true"` —
          screen readers receive only the "Saved" text + the parent
          live region's polite announcement.
        -->
        <span
          class="flex items-center gap-1.5 rounded-full bg-(--color-success-muted) px-2.5 py-1 text-xs font-medium text-(--color-success)"
          data-testid="topbar-save-status-saved"
        >
          <span
            class="size-1.5 rounded-full bg-(--color-success)"
            aria-hidden="true"
          ></span>
          <span>{copy.savedLabel}</span>
        </span>
      {:else if editor.saveStatus === 'error'}
        <span
          class="flex items-center gap-1.5 rounded-full border border-(--color-danger-border) bg-(--color-danger-muted) px-2.5 py-1 text-xs font-medium text-(--color-danger)"
          data-testid="topbar-save-status-error"
        >
          <TriangleAlert class="size-3" aria-hidden="true" />
          <span>{copy.saveErrorLabel}</span>
        </span>
      {/if}
    </div>
  {/if}

  <!--
    Right rail (`sVMX2` "TopBar Right"). The History/Settings/Share
    icon buttons are structural chrome; per-route mutation buttons
    (Save, Run) are mounted inline only when a workflow editor is
    registered so they always target the visible workflow.

    `ml-auto` floats the rail to the trailing edge whether or not the
    Center pill is present (no editor binding → no center column → rail
    still hugs the right edge without an extra spacer). `shrink-0` on
    each child so the cluster never wraps onto a second row even on
    the narrowest viewport — mirrors the design's single-row `Ht9Do`
    invariant.
  -->
  <div class="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
    <!--
      History / Settings / Share are scaffolded into the design (`Ht9Do`
      right rail) but their backing scenarios have not landed yet. We
      keep them rendered for visual fidelity but mark each `disabled`
      so they cannot be activated via pointer or keyboard. The native
      `disabled` attribute keeps HTML semantics, AT semantics, and
      focus order consistent (review note frontend S-1) — `aria-disabled`
      alone left the buttons clickable, which would have triggered any
      delegated handler that landed in the future. Activating one of
      these is now a one-line change: drop the `disabled` and assign
      an `onclick` (or upgrade to `<a href>`).

      `aria-label` carries an sr-only " coming soon" suffix so screen
      readers announce the inert state alongside the role+name pair.
      `title` exposes the same prose as a native browser tooltip on
      hover/focus.

      All three Coming-soon affordances (History / Settings / Share)
      hide together on the narrowest viewports (`< sm`) so the right
      rail keeps room for the Save / Run cluster the user is actively
      operating on. Per review note frontend M-4 their visibility was
      previously asymmetric (History stayed visible while Settings and
      Share collapsed), which left a single inert icon next to the
      working Save/Run pair on phones and squeezed the 44px tap
      targets. Since the controls are chrome only, dropping them all
      below `sm` carries no functional cost.
    -->
    <button
      type="button"
      class="hidden size-8 items-center justify-center rounded-md text-(--color-text-secondary) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-bg-topbar) focus-visible:outline-none sm:flex"
      aria-label={copy.historyAria + copy.comingSoonAriaSuffix}
      title={copy.comingSoonTooltip}
      data-testid="topbar-history-button"
      disabled
    >
      <History class="size-4" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="hidden size-8 items-center justify-center rounded-md text-(--color-text-secondary) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-bg-topbar) focus-visible:outline-none sm:flex"
      aria-label={copy.settingsAria + copy.comingSoonAriaSuffix}
      title={copy.comingSoonTooltip}
      data-testid="topbar-settings-button"
      disabled
    >
      <Settings class="size-4" aria-hidden="true" />
    </button>
    <!--
      Vertical divider before the Share button mirrors `S65OM`
      (1×20). Same token rationale as the left breadcrumb divider
      above: bound to `--color-border-default` so vertical separators
      sit one tier heavier than the bar's bottom hairline, matching
      the design's $border-default value in both themes
      (review note frontend M-A).
    -->
    <span
      class="hidden h-5 w-px bg-(--color-border-default) sm:block"
      aria-hidden="true"
    ></span>
    <!--
      Share button is the design's `H6eVU` pill: 32px tall, 6px radius,
      `$bg-hover` fill, `$border-default` 1px stroke (Dark `#383848` /
      Light `#e4e4e7`). The 1px stroke sits one tier heavier than the
      bar's bottom hairline (`--color-border-topbar`) so the Share pill
      has a visible outline against the `$bg-hover` fill in both themes
      (review note frontend M-A — earlier collapse to
      `--color-border-topbar` left the dark-theme outline at `#2a2a38`
      against `#232333`, only one shade off the fill).
      Icon + label use `--color-text-secondary` to match the design's
      `vXY5C` / `J95ioZ` (`$text-secondary`).
      Coming-soon → native `disabled` per the same rationale as
      History / Settings above.
    -->
    <button
      type="button"
      class="hidden h-8 items-center gap-1.5 rounded-md border border-(--color-border-default) bg-(--color-bg-hover) px-3 text-[13px] font-medium text-(--color-text-secondary) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-bg-topbar) focus-visible:outline-none sm:inline-flex"
      aria-label={copy.shareLabel + copy.comingSoonAriaSuffix}
      title={copy.comingSoonTooltip}
      data-testid="topbar-share-button"
      disabled
    >
      <Share2 class="size-3.5" aria-hidden="true" />
      <span>{copy.shareLabel}</span>
    </button>

    {#if editor}
      <!--
        Save trigger. Wraps the same `SaveButton` the editor previously
        rendered inline so the visible label / accessible name (`Save` /
        `Saving…`) stays identical for the e2e save-workflow scenarios.
        We bind directly to `editor.save` — `editorState`'s contract
        guarantees that swapping the active workflow updates the
        captured id atomically with the buffer (see `syncFromServer`
        invariant).

        Sizing: the bar lands in a 56px row with the design's
        `H6eVU`/`B70DU6` rail at 32px-tall controls (Inter 13/600,
        radius 6, padding [0,12]). The shared `SaveButton` defaults to
        `sm:h-9` (36px) because its other consumers (e.g. the index
        page header at `/`) breathe in a 64px+ header band; the
        `compact` prop switches the >=sm height to `sm:h-8` (32px) and
        rebases the focus-ring offset to `--color-bg-surface` so the
        bar's right cluster stays balanced and the keyboard-focus ring
        stays visible against the Top Bar surface (review-design-topbar
        -frontend.md M-2 — the previous `class="sm:h-8 ..."` override
        depended on `cn()` ordering inside `SaveButton`, which made the
        sizing brittle to wrapper refactors). Mobile keeps `h-11`
        (44px tap target) because the touch-input ergonomics still
        dominate on phones.

        We pass `aria-busy={editor.saving}` for screen readers but
        intentionally NOT `disabled` — taking the button out of the DOM
        focus order mid-save would steal focus from a keyboard user
        about to press Run (review note frontend M-5). Internal
        `editorState.save()` already guards against double-dispatch
        (the second click resolves to the same in-flight promise).
      -->
      <SaveButton
        type="button"
        compact
        aria-busy={editor.saving}
        onclick={() => editor.save()}
      >
        {editor.saving ? editorCopy.savingLabel : editorCopy.saveLabel}
      </SaveButton>
      <!--
        Run trigger. Reuses the existing `RunWorkflowButton` so the
        accent fill, accessible name, retry / busy semantics, and
        scenario contract (POST /api/workflows/:id/runs, surface the
        new run id via `onStarted`) carry over verbatim. `onStarted`
        forwards into the page's binding so the run-detail panel still
        auto-loads the freshly-minted run.

        `compact` floats the success / error caption below the bar
        instead of inline next to the button. The button itself stays
        at 32px so the design's `Ht9Do` 56px row invariant survives
        even when the toast shows "Run started: <long-id>" or a
        multi-word error message.
      -->
      <RunWorkflowButton
        workflowId={editor.workflowId}
        compact
        onStarted={(runId) => editor.onRunStarted(runId)}
      />
    {/if}

    <!--
      Avatar mirrors the design's `ascYO` (28×28 round, blue→indigo
      linear gradient `#3B82F6 → #6366F1`). Static MK initial today;
      future scenarios can surface user state by widening the layout's
      load payload.
    -->
    <span
      class="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 text-[11px] font-semibold text-white"
      aria-hidden="true"
    >
      MK
    </span>
  </div>
</header>
