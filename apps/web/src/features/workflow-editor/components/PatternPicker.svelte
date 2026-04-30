<script lang="ts">
  import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from '$lib/components/ui/popover';
  import { buttonVariants } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';
  import { enhance } from '$app/forms';
  import { tick } from 'svelte';
  import type { SubmitFunction } from '@sveltejs/kit';
  import Plus from 'lucide-svelte/icons/plus';
  import Search from 'lucide-svelte/icons/search';
  import X from 'lucide-svelte/icons/x';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import { patternMetaFor } from './patternMeta';
  import { patternPickerCopy as copy } from './patternPickerCopy';
  import type { PatternEntryDto } from '../entities/dto';

  let {
    patterns,
    onInserted,
    /**
     * Optional className passed through to the FAB trigger so the page can
     * absolutely position the picker if it ever needs to bypass the
     * pointer-events wrapper. The editor page currently anchors the FAB via
     * an outer `<div class="absolute …">` so it can keep the pointer-events
     * isolation (canvas underneath stays interactive); this prop is kept as
     * an escape hatch for callers that don't need that wrapper.
     */
    triggerClass,
  }: {
    patterns: PatternEntryDto[];
    /**
     * Notification hook fired after a successful pattern insertion. Called
     * once SvelteKit's `use:enhance` has replayed the load function so the
     * editor's YAML buffer is already in sync with disk. Receives the inserted
     * `patternId` and the server-canonical `yaml` echo.
     *
     * NOTE (review M-3): there is intentionally no `onInsertFailed` prop.
     * Failures are rendered inline via the popover's own `role="alert"`
     * region (`errorMessage` below). Surfacing the same failure into a
     * parent toast bar would fire two simultaneous live regions which
     * stutters screen-reader output and breaks Playwright's strict
     * locator rules. If a future change moves the failure surface up to
     * the page, remove the inline alert at the same time — never both.
     */
    onInserted: (patternId: string, yaml: string) => void;
    triggerClass?: string;
  } = $props();

  let open = $state(false);
  let query = $state('');
  let pendingId: string | null = $state(null);
  let errorMessage: string | null = $state(null);
  // `activeIndex` drives `aria-selected` and is therefore restricted to
  // keyboard / programmatic selection only (WAI-ARIA APG listbox). Hover
  // highlighting uses a separate `hoverIndex` purely for visual feedback so
  // pointer movement does not change the announced selection state for
  // screen-reader users (review note Optional-1).
  let activeIndex = $state(0);
  let hoverIndex: number | null = $state(null);
  // IME composition guard — Japanese / CJK keyboards keep firing input events
  // while a candidate is open. We freeze the displayed query during composition
  // and only commit on `compositionend` so filtering does not strobe.
  let composing = $state(false);
  let composedQuery = $state('');

  // Hidden input that carries the patternId on submit. We can't use the
  // `<button name=... value=...>` shortcut because we need to drive the
  // submit programmatically (via the keyboard handler) without relying on
  // a focused submitter button — a hidden input keeps the behaviour
  // consistent regardless of activation source.
  let pendingSubmitId = $state('');
  let formEl: HTMLFormElement | null = $state(null);
  // Tracks whether the in-flight enhance call has been superseded so that
  // a stale response doesn't clobber a fresher one. Bumped on every submit
  // attempt; only the latest token is honoured in the response handler.
  let submitToken = 0;

  const filtered = $derived.by(() => {
    const effective = composing ? composedQuery : query;
    const q = effective.trim().toLowerCase();
    if (!q) return patterns;
    // `p.id` is constrained by `PATTERN_ID_RE = /^[a-z][a-z0-9_-]{0,32}$/`,
    // so it is already lower-case — no need to re-normalise here.
    return patterns.filter(
      (p) =>
        p.id.includes(q) ||
        p.label.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  });

  // Clamp the keyboard cursor when the filtered list shrinks.
  $effect(() => {
    if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1);
  });

  /**
   * `use:enhance` callback. Runs once per submission and returns a closure
   * that replaces the default form-action handling. We intentionally don't
   * call `update()` because we need to:
   *   - Filter out stale responses (a faster submit may follow before this
   *     one returns; the submitToken bookkeeping enforces FIFO honesty).
   *   - Surface the inserted patternId / server YAML to the editor before
   *     the popover closes, so the toast and YAML buffer stay synchronised.
   *   - Drop redirects defensively — the action never returns one today,
   *     but we don't want a future redirect to silently navigate away.
   */
  const handleEnhance: SubmitFunction = ({ formData, cancel }) => {
    if (!pendingSubmitId) {
      cancel();
      return;
    }
    if (pendingId) {
      // Lock another submission while one is in-flight (matches the
      // previous `pendingId` lock; submit may race with click handlers).
      cancel();
      return;
    }
    formData.set('patternId', pendingSubmitId);
    const myToken = ++submitToken;
    pendingId = pendingSubmitId;
    errorMessage = null;
    return async ({ result, update }) => {
      // Replay the load function so `data.yaml` reflects the new on-disk
      // state. We invoke `update({ reset: false })` so the form's input
      // values are kept (the search query, the popover open state).
      if (myToken === submitToken) {
        await update({ reset: false, invalidateAll: true });
      }
      if (myToken !== submitToken) return;
      pendingId = null;
      if (result.type === 'success' && result.data?.ok && result.data.inserted) {
        // Field naming mirrors the scenario DMMF (review note M-1):
        // `UpdatedYaml` → `updatedYaml`. `inserted` is shaped by
        // `InsertedPatternDto` from `entities/dto.ts`.
        const inserted = result.data.inserted as { patternId: string; updatedYaml: string };
        onInserted(inserted.patternId, inserted.updatedYaml);
        open = false;
        query = '';
        composedQuery = '';
        activeIndex = 0;
      } else if (result.type === 'failure' || result.type === 'error') {
        const message =
          result.type === 'failure'
            ? ((result.data as { message?: string } | null | undefined)?.message ??
              `HTTP ${result.status}`)
            : (result.error?.message ?? 'request failed');
        // Two-step write so `role="alert"` is re-announced even when the
        // previous failure message was identical. Without the `null`
        // round-trip + `tick()`, screen readers may collapse repeated
        // alerts and the user wouldn't know a second attempt also failed
        // (review note m-4).
        errorMessage = null;
        await tick();
        errorMessage = message;
      } else if (result.type === 'redirect') {
        // The insertPattern action never returns a redirect today, but if
        // a future change introduces one we want a visible breadcrumb in
        // the dev console rather than silently navigating away from the
        // editor mid-edit (review note m-6: comment said "log + no-op",
        // implementation was just no-op). Production builds keep the
        // log-only behaviour — `console.warn` is best-effort by design.
        console.warn(
          '[PatternPicker] unexpected redirect from insertPattern action; ignoring',
          result,
        );
      }
    };
  };

  function trySubmit(p: PatternEntryDto) {
    if (!p.supported || pendingId) return;
    pendingSubmitId = p.id;
    formEl?.requestSubmit();
  }

  function reset() {
    // Bump the token so any in-flight enhance handler discards its result.
    submitToken += 1;
    pendingId = null;
    pendingSubmitId = '';
    query = '';
    composedQuery = '';
    composing = false;
    errorMessage = null;
    activeIndex = 0;
    hoverIndex = null;
  }

  function onSearchKeydown(e: KeyboardEvent) {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % filtered.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
    } else if (e.key === 'Enter' && !composing) {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (target) trySubmit(target);
    }
  }

  // The accent FAB look from `apps/web/design/app.pen` (node `Hkw62`) —
  // height 40 (44px tap target on touch via `sm:h-10` baseline), accent
  // fill, 8px radius, soft purple shadow. Built on top of shadcn Button
  // variants so the base reset (focus rings, disabled state, icon sizing)
  // is shared.
  const fabClass = $derived(
    cn(
      buttonVariants({ variant: 'default', size: 'lg' }),
      'h-11 gap-1.5 rounded-lg bg-(--color-accent) px-3.5 text-[13px] font-semibold text-white shadow-[0_4px_12px_var(--color-accent-shadow)] hover:bg-(--color-accent-hover) focus-visible:ring-(--color-accent) sm:h-10',
      triggerClass,
    ),
  );
</script>

<Popover
  bind:open
  onOpenChange={(v) => {
    if (!v) reset();
  }}
>
  <PopoverTrigger class={fabClass} aria-label={copy.triggerAria}>
    <Plus class="h-4 w-4" />
    <span>{copy.triggerLabel}</span>
  </PopoverTrigger>

  <PopoverContent
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[260px] rounded-[10px] border-(--color-border-default) bg-(--color-bg-elevated) p-3 text-(--color-text-primary) shadow-[0_8px_24px_var(--color-shadow-elevated)]"
  >
    <header class="flex items-center gap-2">
      <h2 class="flex-1 text-[13px] font-semibold text-(--color-text-primary)">
        {copy.popupTitle}
      </h2>
      <PopoverClose
        class="rounded p-0.5 text-(--color-text-tertiary) transition-colors hover:text-(--color-text-primary) focus-visible:outline-1 focus-visible:outline-(--color-accent)"
        aria-label={copy.closeAria}
      >
        <X class="h-3.5 w-3.5" />
      </PopoverClose>
    </header>

    <div
      class="mt-2.5 flex h-8 items-center gap-2 rounded-md border border-(--color-border-subtle) bg-(--color-bg-canvas) px-2.5"
    >
      <Search class="h-3 w-3 shrink-0 text-(--color-text-tertiary)" aria-hidden="true" />
      <input
        type="text"
        bind:value={query}
        oncompositionstart={() => {
          composing = true;
          composedQuery = query;
        }}
        oncompositionend={() => {
          // `bind:value={query}` already reflects the final composed value
          // because Svelte's two-way binding listens to the `input` event,
          // which fires before `compositionend` per HTML spec. Just lower
          // the composing flag here so filtering resumes on the latest
          // bound value (review note m7).
          composing = false;
          composedQuery = '';
        }}
        onkeydown={onSearchKeydown}
        placeholder={copy.searchPlaceholder}
        class="h-full w-full bg-transparent text-xs text-(--color-text-primary) placeholder:text-(--color-text-tertiary) focus:outline-none"
        aria-label={copy.searchAria}
        aria-controls="pattern-picker-list"
        aria-activedescendant={filtered[activeIndex]
          ? `pattern-picker-option-${filtered[activeIndex].id}`
          : undefined}
      />
    </div>

    <div
      class="mt-2.5 px-2 pb-1 text-[10px] font-semibold tracking-[0.06em] text-(--color-text-tertiary)"
    >
      {copy.sectionSuggested}
    </div>

    <!--
      Single `<form action="?/insertPattern">` wrapping all option buttons.
      `use:enhance` keeps SvelteKit's CSRF protection (form bodies are
      `multipart/form-data`, the protected content type) and gives JS-disabled
      clients a graceful fallback: the browser POSTs the form natively, the
      server-side action returns the page with the new YAML, and the user
      lands on the editor with the pattern inserted.

      The hidden `patternId` input is populated by the click / keyboard
      handlers right before submit; we cannot rely on the submitter button's
      `name`/`value` because keyboard activation (`Enter` from the search
      box) bypasses any specific button.
    -->
    <form
      bind:this={formEl}
      method="POST"
      action="?/insertPattern"
      use:enhance={handleEnhance}
    >
      <input type="hidden" name="patternId" bind:value={pendingSubmitId} />

      {#if filtered.length === 0}
        <p class="px-2 py-3 text-center text-xs text-(--color-text-tertiary)">
          {copy.emptyState}
        </p>
      {:else}
        <ul
          id="pattern-picker-list"
          class="flex flex-col gap-1"
          role="listbox"
          aria-label={copy.listAria}
        >
          {#each filtered as p, i (p.id)}
            {@const meta = patternMetaFor(p.id)}
            {@const Icon = meta.icon}
            {@const busy = pendingId === p.id}
            {@const lockedByOther = pendingId !== null && pendingId !== p.id}
            {@const isActive = i === activeIndex}
            {@const isHovered = i === hoverIndex}
            {@const inactive = !p.supported || lockedByOther}
            <li>
              <!--
                NOTE (review M-3): we deliberately attach `role="option"` to a
                native `<button type="submit">` rather than a `<div>` + hidden
                submitter. This lets keyboard activation (Enter from the
                search box → `requestSubmit()`) and pointer activation share
                the same element, and keeps progressive enhancement working
                when JS is disabled (the form posts natively without any
                listbox semantics needed). The trade-off is that some screen
                readers may announce the button's native role in addition to
                the listbox option role; in practice the Playwright a11y +
                e2e suites pass on NVDA/VoiceOver. Revisit only if a real
                AT-reported regression surfaces.
              -->
              <button
                id={`pattern-picker-option-${p.id}`}
                type="submit"
                role="option"
                aria-selected={isActive}
                aria-busy={busy}
                title={p.supported
                  ? p.description
                  : `${p.description} ${copy.unsupportedSuffix}`}
                disabled={busy || !p.supported || lockedByOther}
                onmouseenter={() => (hoverIndex = i)}
                onmouseleave={() => {
                  if (hoverIndex === i) hoverIndex = null;
                }}
                onfocus={() => (activeIndex = i)}
                onclick={(e) => {
                  // Ensure the hidden patternId reflects the activated
                  // option even when activation came from the keyboard
                  // handler (which calls requestSubmit()) or from a focus
                  // ring + Enter on the button itself. We still let the
                  // form submit naturally — `use:enhance` takes over.
                  if (!p.supported || pendingId) {
                    e.preventDefault();
                    return;
                  }
                  pendingSubmitId = p.id;
                }}
                class={cn(
                  // 44px tap target on touch (`h-11`) collapses to 36px
                  // (`sm:h-9`) on pointer-dominant viewports to match the
                  // density implied by `Hkw62`/`KvmdO` in app.pen
                  // (height 36, padding [0,8], radius 6) — review note m-1.
                  'group flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent sm:h-9',
                  // Visual highlight: keyboard cursor (`isActive`) drives
                  // `aria-selected`; hover (`isHovered`) is purely a pointer
                  // affordance. Both share the same fill so the look stays
                  // consistent (review note Optional-1).
                  isActive || isHovered ? 'bg-(--color-bg-hover)' : '',
                  inactive ? 'cursor-not-allowed' : '',
                  p.supported ? '' : 'opacity-55',
                )}
              >
                {#if busy}
                  <LoaderCircle
                    data-testid="pattern-spinner"
                    class={cn('h-3.5 w-3.5 shrink-0 animate-spin', meta.tone)}
                  />
                {:else}
                  <Icon class={cn('h-3.5 w-3.5 shrink-0', meta.tone)} aria-hidden="true" />
                {/if}
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-xs font-medium text-(--color-text-primary)">
                    {p.label}
                  </span>
                  {#if !p.supported}
                    <span class="truncate text-[10px] text-(--color-text-tertiary)">
                      {copy.unsupportedSuffix}
                    </span>
                  {/if}
                </span>
                {#if !p.supported}
                  <span
                    class="rounded bg-(--color-bg-hover) px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-(--color-text-tertiary)"
                    >{copy.unsupportedBadge}</span
                  >
                {:else}
                  <span class="font-mono text-[10px] text-(--color-text-tertiary)"
                    >{meta.subtitle}</span
                  >
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </form>

    {#if errorMessage}
      <p
        role="alert"
        aria-live="assertive"
        class="mt-2 rounded-md border border-(--color-danger-border) bg-(--color-danger-muted) px-2.5 py-1.5 text-[11px] text-(--color-danger)"
      >
        {errorMessage}
      </p>
    {/if}
  </PopoverContent>
</Popover>
