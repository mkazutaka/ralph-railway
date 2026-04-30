<!--
  Test Node panel.

  Implements the "Test Node" scenario
  (`apps/web/docs/scenarios/workflow-editor/test-node.md`). Lets the user
  pick a single node id, optionally provide dummy inputs, and execute the
  node in isolation against the runtime adapter — without affecting the
  workflow's persistent Run history (scenario invariant 1) or rewriting
  the YAML (invariant 2).

  Visual idiom is borrowed from the design's Right Panel
  (`SV10l/Hv0EB` "testSection" + `Rjrdv` "testBtn" + `a1DWw` "statusRow"
  in `apps/web/design/app.pen`):
    - Section heading (small uppercase + tertiary tint), matching the
      `RECENT RUNS` / `RUN DETAIL` panels stacked above it.
    - Stacked field labels above 36px-tall input rows on
      `$bg-elevated`/`$border-default`, mirroring `Y9PbY`/`gYLnT`/
      `EoWDx`/`azraj`/`sTEsS` (the per-node settings groups).
    - Add Input button mirrors `ukI2B` ("+ Add Input", accent text + plus
      icon).
    - Trigger button mirrors `Rjrdv` (full-width 36px, accent fill, white
      "Test Step" label + play icon).
    - Result row mirrors `a1DWw` (status dot · "<duration> · <Status>").

  Mount location is provisional — the canonical home is the design's
  Right Panel (`SV10l`, width 340), which today renders the per-node
  settings tabs and has not been migrated from a static design to a
  React-style settings editor yet. Until that scenario lands, we mount
  the panel underneath the run-detail panel on the workflow editor page,
  inside the same scrollable column. The panel caps its own height +
  scrolls vertically so a long inputs list cannot push the run-detail
  panel off-screen, mirroring the recent-runs / run-detail siblings.

  Data flow: the panel owns its own POST against
  `POST /api/workflows/:id/nodes/:nodeId/test`. The `+page.server.ts`
  load function does NOT include the test endpoint (it would force a
  body shape onto a load function that other consumers do not need),
  and a query-style remote function would be a poor fit because the
  request is mutating-shaped (it carries a body) even though it does
  not mutate persistent state.

  Scenario invariants (encoded here):
    1. 単独テストはワークフロー本体の Run 履歴に永続化されない —
       enforced by the server (`testNodeWorkflow` does not touch
       `RunStore`). The panel never reads or writes a run id. The
       `noPersistNote` copy is rendered both in the empty state and
       inside the result section so the user is told ahead of time
       AND reassured after the test runs (review note M-1).
    2. テスト実行はファイル（YAML）を変更しない — enforced by the server
       (`readWorkflowFile` is read-only, `executeNodeOnce` cannot reach
       back into the file repository).
    3. NodeNotTestable のノードには事前に拒否する — surfaced as a 409
       inline alert; the trigger stays enabled so the user can pick a
       different node id.
    4. ダミー入力の型不一致は実行前に検出する — surfaced as a 422 inline
       alert with the server's `reason` (e.g. "missing required
       working_directory") forwarded verbatim.

  Out of scope (intentionally): schema-guided value editing for declared
  `with:` shapes (a future Right Panel scenario will own that), and
  persistence across reloads. The panel ships as a single self-contained
  surface that delegates validation entirely to the server. Node-id
  auto-completion is provided via a `<datalist>` populated from the
  `nodeIds` prop (review note M-2) so the user does not have to memorise
  every node id while the canonical Right Panel scenario is pending.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Play from 'lucide-svelte/icons/play';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import Plus from 'lucide-svelte/icons/plus';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { cn } from '$lib/utils';
  import type { NodeTestResultDto } from '../entities/dto';
  import { testNode } from '../lib/testNodeApi';
  import { testNodeCopy as copy } from './testNodeCopy';
  import {
    formatTestDuration,
    testNodeStatusDotVar,
    testNodeStatusLabel,
    testNodeStatusToneVar,
  } from './testNodeFormat';

  let {
    workflowId,
    /** Optional initial node id (e.g. when the user has just selected a
     * node on the canvas). The panel still lets the user edit the field
     * before sending. */
    initialNodeId = '',
    /**
     * Optional list of node ids parsed from the YAML buffer. Surfaced as
     * a `<datalist>` so the node-id input offers in-place suggestions
     * rather than forcing the user to memorise every id (review note
     * M-2). The list is advisory only — server validation still runs and
     * the user is free to type a value that is not in the list (e.g.
     * while typing a half-finished id, or against a yet-to-be-saved
     * node).
     */
    nodeIds = [],
    /**
     * Override hook for tests (Vitest / MSW). Resolves `globalThis.fetch`
     * at *call* time so a test harness can swap `globalThis.fetch` after
     * construction and still observe the call (mirrors
     * `RunWorkflowButton.svelte` / `RecentRuns.svelte`).
     */
    fetcher,
    /** Optional className passed through for layout-level overrides. */
    class: className,
  }: {
    workflowId: string;
    initialNodeId?: string;
    nodeIds?: ReadonlyArray<string>;
    fetcher?: typeof fetch;
    class?: string;
  } = $props();

  /**
   * Dummy-input rows. Each row owns a stable `id` so iteration keys remain
   * stable across re-orders / removals (Svelte 5 each-block keys must be
   * unique and reactive-stable; using the array index here would re-bind
   * the `<input>` value every time the user inserts/removes a row above
   * it). The id is a monotonic counter local to this component instance.
   */
  // Seed `nodeId` from `initialNodeId` *once* at construction. Subsequent
  // updates of the prop are intentionally ignored — the field is an
  // editable buffer owned by this component (mirrors the editor's
  // `createEditorState` initial-yaml seed pattern). The lint rule
  // `state_referenced_locally` is therefore expected here.
  // svelte-ignore state_referenced_locally
  let nodeId = $state(initialNodeId);
  let nextRowId = 1;
  function freshInputRows(): { id: number; key: string; value: string }[] {
    return [{ id: nextRowId++, key: '', value: '' }];
  }
  let inputRows: { id: number; key: string; value: string }[] = $state(
    freshInputRows(),
  );

  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'success'; result: NodeTestResultDto }
    | { kind: 'error'; message: string };

  // Annotate with the union type so later assignments are not narrowed away
  // by TypeScript inferring the initial literal as `{ kind: 'idle' }`.
  let status = $state<Status>({ kind: 'idle' });
  let busy = $derived(status.kind === 'pending');
  // The trigger is disabled while a request is in-flight OR when the user
  // has not entered a node id. We still let an empty inputs list through
  // because the server accepts `{}` as the no-inputs sentinel (see the
  // `inputs ?? {}` branch in the route handler).
  let canSubmit = $derived(!busy && nodeId.trim().length > 0);

  // Track the in-flight controller so an unmount or rapid click sequence
  // aborts the previous request before kicking off a new one (mirrors
  // `RunWorkflowButton` / `StopRunButton`).
  let controller: AbortController | null = null;
  // Guard the construction-time `$effect` reset so we don't immediately
  // wipe out the seeded `initialNodeId` / first input row. Without this,
  // the effect that runs once on mount would clear the freshly-seeded
  // `nodeId` to '' before the user gets a chance to interact (review note
  // M-3 — we want to reset on workflow id *change*, not on initial mount).
  let didMountReset = false;
  onDestroy(() => controller?.abort());

  // Reset the buffered editor state when the user navigates to a different
  // workflow. Without this, a stale "Succeeded · 250ms" caption from the
  // previous workflow would linger, AND the previously-typed node id /
  // dummy inputs would survive across workflows where they are unlikely to
  // resolve to the same node (review note M-3). On the very first run
  // (mount) we skip the reset so the construction-time `initialNodeId` /
  // first input row are preserved.
  $effect(() => {
    // Re-read the dependency explicitly so the linter / human reader
    // can see what drives the reset.
    const _wf = workflowId;
    void _wf;
    if (!didMountReset) {
      didMountReset = true;
      return;
    }
    controller?.abort();
    status = { kind: 'idle' };
    nodeId = '';
    inputRows = freshInputRows();
  });

  /**
   * Build the `Record<string, unknown>` body the server expects from the
   * UI's row state. Empty keys are dropped (a key with no name is a
   * placeholder row from the user's perspective). Duplicate keys keep
   * the last-write-wins semantics that JSON object literals follow at
   * runtime — the client surfaces this implicitly via row order.
   *
   * Values are forwarded as plain strings; the server's
   * `validateNodeInputs` will compare the JS type against the node's
   * declared `with:` shape and reject mismatches (scenario invariant 4).
   * For numeric / boolean fields the user must type the literal string
   * for now — a future enhancement could surface schema-aware value
   * editors when the Right Panel scenario lands.
   */
  function collectInputs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of inputRows) {
      const k = row.key.trim();
      if (k.length === 0) continue;
      out[k] = row.value;
    }
    return out;
  }

  function addRow() {
    inputRows = [...inputRows, { id: nextRowId++, key: '', value: '' }];
  }

  function removeRow(rowId: number) {
    inputRows = inputRows.filter((row) => row.id !== rowId);
    if (inputRows.length === 0) {
      // Always keep at least one row so the inputs editor is never a blank
      // surface — the user would otherwise have to click "Add Input"
      // before they could start typing the first key/value pair.
      inputRows = freshInputRows();
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    status = { kind: 'pending' };

    const result = await testNode(workflowId, nodeId.trim(), collectInputs(), {
      signal: ac.signal,
      fetcher,
    });
    if (ac.signal.aborted) return;

    if (result.ok) {
      status = { kind: 'success', result: result.result };
      return;
    }
    if (result.kind === 'cancelled') {
      // Aborted by an unmount or a rapid follow-up click — leave the UI
      // as-is so the next click starts cleanly.
      return;
    }
    status = { kind: 'error', message: result.message };
  }

  // IDs for explicit label↔input wiring (Svelte 5 + shadcn-svelte Input
  // does not auto-generate `for` ↔ `id` pairings). Keep them static within
  // a component instance so accessibility tooling can treat them as a
  // stable region.
  const NODE_ID_INPUT = 'test-node-id';
  const HEADING_ID = 'test-node-heading';
  const NODE_ID_DATALIST = 'test-node-id-suggestions';

  // Deduplicate suggestion list so the `<datalist>` does not render the
  // same id twice if the YAML accidentally repeats one (the server-side
  // parser rejects duplicates, but a half-typed buffer can transiently
  // contain them while the user is editing).
  let uniqueNodeIds = $derived(Array.from(new Set(nodeIds)));
</script>

<!--
  Section container. Caps its own height (`max-h-[40vh]`) and scrolls
  vertically until the proper Right Panel lands; mirrors the recent-runs
  + run-detail siblings stacked above it. `border-t` matches the divider
  style they share.

  `<section aria-labelledby>` resolves to an accessible region with the
  heading text as its name, so E2E tests can target the panel via
  `getByRole('region', { name: 'TEST NODE' })` (mirrors the convention
  used by the recent-runs / run-detail panels).
-->
<section
  class={cn(
    'flex max-h-[40vh] min-h-0 flex-col overflow-y-auto border-t border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-primary)',
    className,
  )}
  aria-labelledby={HEADING_ID}
  data-testid="test-node-panel"
>
  <!--
    Header row. Padding tokens [10, 12, 6, 14] mirror the design's
    `recentTitle` (`k3LmuC`) and the run-detail header so the three
    stacked panels share visual rhythm.
  -->
  <h2
    id={HEADING_ID}
    class="pt-2.5 pr-3 pb-1.5 pl-3.5 text-[10px] font-bold tracking-[0.08em] text-(--color-text-tertiary)"
  >
    {copy.sectionTitle}
  </h2>

  <!--
    Form body. `submit` instead of a click handler so a keyboard user can
    activate the trigger via the standard Enter-while-focused-on-input
    flow. `novalidate` because the server is the source of truth on shape
    validation (the field accepts free-form text and only rejects on the
    server's brand check / 422 dummy-input mismatch).
  -->
  <form
    class="flex flex-col gap-3 px-3.5 pt-1 pb-3"
    onsubmit={(e) => {
      e.preventDefault();
      void handleSubmit();
    }}
    novalidate
  >
    <!-- Node id field -->
    <div class="flex flex-col gap-1.5">
      <Label
        for={NODE_ID_INPUT}
        class="text-[12px] font-medium text-(--color-text-secondary)"
      >
        {copy.nodeIdLabel}
      </Label>
      <Input
        id={NODE_ID_INPUT}
        type="text"
        bind:value={nodeId}
        placeholder={copy.nodeIdPlaceholder}
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        list={uniqueNodeIds.length > 0 ? NODE_ID_DATALIST : undefined}
        class={cn(
          // Mirror the design's input rows (`Y9PbY` etc.): 36px tall,
          // elevated background, default border, rounded.
          'h-9 rounded-md border-(--color-border-default) bg-(--color-bg-elevated) font-mono text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary)',
        )}
        data-testid="test-node-id-input"
      />
      {#if uniqueNodeIds.length > 0}
        <!--
          Suggestion list mirroring the workflow's parsed node ids
          (review note M-2). `<datalist>` is an HTML primitive, not a
          shadcn-svelte component — there is no equivalent in the
          design system, and the native widget gives us keyboard +
          screen-reader support for free across browsers.
        -->
        <datalist id={NODE_ID_DATALIST} aria-label={copy.nodeIdSuggestionsAria}>
          {#each uniqueNodeIds as id (id)}
            <option value={id}></option>
          {/each}
        </datalist>
      {/if}
    </div>

    <!-- Dummy inputs editor -->
    <div class="flex flex-col gap-2">
      <Label class="text-[12px] font-medium text-(--color-text-secondary)">
        {copy.inputsLabel}
      </Label>
      <p class="text-[10px] text-(--color-text-tertiary)">
        {copy.inputsHelper}
      </p>
      <ul class="flex flex-col gap-2" aria-label={copy.inputsLabel}>
        {#each inputRows as row (row.id)}
          <li class="flex items-center gap-2">
            <Input
              type="text"
              bind:value={row.key}
              placeholder={copy.inputsKeyPlaceholder}
              autocapitalize="off"
              autocomplete="off"
              spellcheck="false"
              aria-label={`${copy.inputsLabel} ${copy.inputsKeyPlaceholder}`}
              class={cn(
                'h-9 flex-1 rounded-md border-(--color-border-default) bg-(--color-bg-elevated) font-mono text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary)',
              )}
              data-testid="test-node-input-key"
            />
            <Input
              type="text"
              bind:value={row.value}
              placeholder={copy.inputsValuePlaceholder}
              autocapitalize="off"
              autocomplete="off"
              spellcheck="false"
              aria-label={`${copy.inputsLabel} ${copy.inputsValuePlaceholder}`}
              class={cn(
                'h-9 flex-1 rounded-md border-(--color-border-default) bg-(--color-bg-elevated) font-mono text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary)',
              )}
              data-testid="test-node-input-value"
            />
            <!--
              Row-remove icon button (review note m-4): wrap the lucide
              icon in shadcn-svelte's `Button` so we inherit the focus
              ring, hover, and disabled tokens shared by every button on
              the page. `variant="ghost"` matches the design's accent-on-
              hover idiom, `size="icon"` is the 36×36 icon-only preset.
            -->
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onclick={() => removeRow(row.id)}
              aria-label={copy.removeInputAria}
              class="size-9 shrink-0 rounded-md text-(--color-text-tertiary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
              data-testid="test-node-input-remove"
            >
              <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
            </Button>
          </li>
        {/each}
      </ul>
      <!--
        Add-row trigger (review note m-4). Wrapped in shadcn-svelte's
        `Button` (`variant="ghost"`, `size="sm"`) so the focus ring and
        active states stay consistent with the rest of the panel. The
        accent text + plus icon mirrors design `ukI2B`.
      -->
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={addRow}
        class="h-auto self-start gap-1 rounded px-1 py-1.5 text-[12px] font-medium text-(--color-accent) hover:bg-transparent hover:text-(--color-accent) hover:underline"
        data-testid="test-node-input-add"
      >
        <Plus class="size-3.5 shrink-0" aria-hidden="true" />
        <span>{copy.addInputLabel}</span>
      </Button>
    </div>

    <!-- Trigger -->
    <Button
      type="submit"
      variant="default"
      size="sm"
      aria-label={copy.triggerAria}
      aria-busy={busy}
      aria-disabled={!canSubmit}
      disabled={!canSubmit}
      class={cn(
        // Mirror design `Rjrdv` "testBtn": full-width 36px, accent fill,
        // white label, 6px gap between icon and text. 44px tap target on
        // touch (`h-11`) collapses to 36px on >=sm where pointer input
        // dominates (mirrors RunWorkflowButton's policy).
        'h-11 w-full justify-center gap-1.5 rounded-md bg-(--color-accent) px-3.5 text-[13px] font-semibold text-white shadow-[0_4px_12px_var(--color-accent-shadow)] hover:bg-(--color-accent-hover) focus-visible:ring-(--color-accent) disabled:cursor-not-allowed disabled:opacity-60 sm:h-9',
      )}
      data-testid="test-node-trigger"
    >
      {#if busy}
        <LoaderCircle
          class="h-3.5 w-3.5 shrink-0 animate-spin"
          aria-hidden="true"
          data-testid="test-node-spinner"
        />
        <span>{copy.triggerBusyLabel}</span>
      {:else}
        <Play class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{copy.triggerLabel}</span>
      {/if}
    </Button>

    <!-- Result / error region. Single `<output>`-style block so screen
         readers can locate the most-recent feedback in one place. We
         deliberately use `aria-live="polite"` (not `assertive`) for the
         success branch: the result is the user-requested outcome, not a
         system-driven interruption. The error branch uses `role="alert"`
         because the user usually needs to act on it (mirrors the
         RunWorkflowButton / StopRunButton policy). -->
    {#if status.kind === 'idle'}
      <p class="text-[11px] text-(--color-text-tertiary)">
        {copy.emptyState}
      </p>
    {:else if status.kind === 'pending'}
      <p
        class="text-[11px] text-(--color-text-tertiary)"
        role="status"
        aria-live="polite"
        data-testid="test-node-pending"
      >
        {copy.triggerBusyLabel}
      </p>
    {:else if status.kind === 'error'}
      <!--
        `role="alert"` already implies `aria-live="assertive"`; we keep the
        explicit attribute alongside the role for older AT (matches the
        `RunWorkflowButton` / `StopRunButton` convention so screen readers
        announce errors uniformly across the page).
      -->
      <p
        class="rounded border border-(--color-danger-border) bg-(--color-danger-muted) px-2 py-1.5 text-[11px] text-(--color-danger)"
        role="alert"
        aria-live="assertive"
        data-testid="test-node-error"
      >
        {status.message}
      </p>
    {:else}
      {@const result = status.result}
      <section
        aria-label={copy.resultHeading}
        class="flex flex-col gap-2 rounded-md border border-(--color-border-default) bg-(--color-bg-elevated) p-2.5"
        data-testid="test-node-result"
      >
        <!--
          Result row mirrors design `a1DWw` "statusRow": 6px dot, then
          status word, then duration. Capitalised status word so the
          tone matches the design's `gTR6n` ("Success"). `role="status"`
          so the announcement is polite — the result is information, not
          an interruption.
        -->
        <div
          class="flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <span
            class="inline-block size-2 shrink-0 rounded-full"
            style="background-color: var({testNodeStatusDotVar(result.status)})"
            data-testid="test-node-status-dot"
            aria-hidden="true"
          ></span>
          <span
            class="shrink-0 text-[11px] font-medium"
            style="color: var({testNodeStatusToneVar(result.status)})"
          >
            {testNodeStatusLabel(result.status)}
          </span>
          <span class="text-[11px] text-(--color-text-tertiary)">·</span>
          <span class="text-[11px] text-(--color-text-tertiary)">
            {formatTestDuration(result.durationMs)}
          </span>
          <span
            class="ml-auto min-w-0 truncate font-mono text-[10px] text-(--color-text-tertiary)"
            title={result.nodeId}
          >
            {result.nodeId}
          </span>
        </div>

        {#if result.status === 'failed' && result.errorMessage !== null}
          <!--
            Failed test: scenario invariant constrains `errorMessage` to
            be non-null when `status === 'failed'`. Surface it inline as
            the most-read piece of information for a failed test.
          -->
          <div class="flex flex-col gap-1">
            <span
              class="text-[10px] font-semibold tracking-wide text-(--color-danger) uppercase"
            >
              {copy.resultErrorLabel}
            </span>
            <!--
              Cap the error message height (review note m-6). The parent
              section already scrolls vertically (`max-h-[40vh]
              overflow-y-auto`), but a multi-screen stack trace would still
              push the output / log blocks below the visible area. A local
              `max-h-48` + `overflow-y-auto` keeps each result block
              independently scrollable so the user always sees ALL three
              labels (Error / Output / Log) at once.
            -->
            <pre
              class="max-h-48 overflow-x-auto overflow-y-auto rounded bg-(--color-danger-muted) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-danger)"
              data-testid="test-node-error-message">{result.errorMessage}</pre>
          </div>
        {/if}

        <!--
          Output rendering distinguishes three states (review note m-2):

          1. `output === null` → the node has no declared output field (or
             the runtime adapter never populated one). For a successful
             test we show "No output produced." so the user can tell "the
             node ran and produced nothing" from "the panel is still
             loading"; for a failed test we omit the row entirely because
             the error message above already carries the actionable
             information.
          2. `output === ""` → the output field IS declared but its value
             is empty. Render a labelled `<pre>` like any other output —
             the entity layer treats `""` and `null` as different values
             (`entities/nodeTestResult.ts`) and the UI must respect the
             distinction (the user wrote a node that produces an empty
             string on purpose).
          3. `output` is a non-empty string → standard rendering, capped
             at `max-h-48` so a multi-megabyte payload cannot push the
             log block off-screen (mirrors the error block; review note
             m-6).
        -->
        {#if result.output === null}
          {#if result.status === 'succeeded'}
            <p
              class="text-[10px] text-(--color-text-tertiary)"
              data-testid="test-node-output-empty"
            >
              {copy.noOutput}
            </p>
          {/if}
        {:else}
          <div class="flex flex-col gap-1">
            <span
              class="text-[10px] font-semibold tracking-wide text-(--color-text-tertiary) uppercase"
            >
              {copy.resultOutputLabel}
            </span>
            <pre
              class="max-h-48 overflow-x-auto overflow-y-auto rounded bg-(--color-bg-canvas) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-text-secondary)"
              data-testid="test-node-output">{result.output}</pre>
          </div>
        {/if}

        {#if result.logExcerpt.length > 0}
          <div class="flex flex-col gap-1">
            <span
              class="text-[10px] font-semibold tracking-wide text-(--color-text-tertiary) uppercase"
            >
              {copy.resultLogLabel}
            </span>
            <!-- Same per-block scroll cap as Output / Error (review note
                 m-6) so each section stays independently legible even with
                 a long log excerpt. -->
            <pre
              class="max-h-48 overflow-x-auto overflow-y-auto rounded bg-(--color-bg-canvas) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-text-tertiary)"
              data-testid="test-node-log">{result.logExcerpt}</pre>
          </div>
        {/if}

        <!--
          Scenario invariant 1 reassurance (review note M-1). Sits at the
          bottom of the result section so the user, having just observed
          the test outcome, sees the explicit promise that this run did
          not pollute the Recent Runs list above.
        -->
        <p
          class="text-[10px] text-(--color-text-tertiary) italic"
          data-testid="test-node-no-persist-note"
        >
          {copy.noPersistNote}
        </p>
      </section>
    {/if}
  </form>
</section>
