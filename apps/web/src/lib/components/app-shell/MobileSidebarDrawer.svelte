<!--
  Mobile-only sidebar drawer.

  Why this exists: the desktop `<aside>` (`LeftSidebar.svelte`) is
  hidden below the `lg` breakpoint because the design's 260px panel
  cannot share a row with the canvas on phone-sized viewports. Without
  a mobile entry point, users on `< lg` had no way to switch
  workflows once they had drilled into the editor route — the design
  review explicitly flagged this as a regression
  (`docs/tasks/review-design.md` item 2).

  Implementation: a thin wrapper around `bits-ui`'s headless Dialog
  primitive (the same primitive `shadcn-svelte`'s Sheet sits on). We
  do NOT touch `$lib/components/ui/` — that directory is reserved for
  the unmodified shadcn-svelte registry. Instead, we compose Dialog +
  Tailwind here so the drawer's chrome stays in step with the design
  tokens (`--color-bg-surface`, `--color-border-default`, …) and the
  mobile-only slide-in animation is owned by the layout component
  rather than a generic UI primitive.

  Visibility: the trigger lives in the Top Bar's left rail
  (`TopBar.svelte`) where it is `lg:hidden`. The drawer body itself
  is rendered through bits-ui's `Portal`, so it floats above page
  content and adopts the dialog focus-trap / Escape-to-close /
  click-outside-to-close behaviours for free.
-->
<script lang="ts">
  import { Dialog } from 'bits-ui';
  import Menu from 'lucide-svelte/icons/menu';
  import X from 'lucide-svelte/icons/x';
  import type { WorkflowSummaryDto } from '$features/workflow-editor/entities/dto';
  import SidebarContent from './SidebarContent.svelte';
  import { leftSidebarCopy as copy } from './leftSidebarCopy';

  let {
    workflows,
  }: {
    workflows: ReadonlyArray<WorkflowSummaryDto>;
  } = $props();

  /**
   * Drawer visibility. Owned here (rather than uncontrolled) so the
   * `onNavigate` callback wired into `SidebarContent` can close the
   * drawer when the user activates a workflow row — without controlled
   * state we'd need to dispatch a synthetic close event from inside the
   * file-row anchor, which the bits-ui Dialog API does not expose.
   */
  let open = $state(false);
</script>

<Dialog.Root bind:open>
  <!--
    Trigger. Visible only `< lg`; the desktop sidebar handles its own
    surface above that breakpoint. The button intentionally renders as
    an icon-only affordance so it slots into the Top Bar's left rail
    without competing with the brand mark.
  -->
  <Dialog.Trigger
    class="flex size-9 items-center justify-center rounded-md text-(--color-text-secondary) hover:bg-(--color-bg-hover) focus-visible:bg-(--color-bg-hover) focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none lg:hidden"
    aria-label={copy.mobileTriggerAria}
  >
    <Menu class="size-5" aria-hidden="true" />
  </Dialog.Trigger>

  <Dialog.Portal>
    <!--
      Overlay. Dim the page so focus shifts to the drawer; the
      Dialog primitive already handles the click-outside-to-close
      contract, we only paint the surface.
    -->
    <Dialog.Overlay
      class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
    />
    <!--
      Drawer surface. Anchored to the left edge to mirror the desktop
      sidebar's anchor; width 280px keeps the file rows readable on the
      smallest supported viewport (375px) while still leaving overlay
      tap-target so users can dismiss without reaching for the close
      button. We deliberately avoid `tailwindcss-animate` enter/exit
      classes (not installed in this app) — the dialog primitive opens
      / closes instantly which is acceptable for a navigation drawer.
    -->
    <Dialog.Content
      aria-label={copy.mobileDialogAria}
      class="fixed top-0 left-0 z-50 flex h-[100dvh] w-[280px] max-w-[85vw] flex-col border-r border-(--color-border-default) bg-(--color-bg-surface) shadow-lg outline-none"
    >
      <!--
        Visually-hidden Dialog title + description satisfy the bits-ui
        a11y contract — bits-ui warns when neither is bound. We expose
        a Title (preferred) and a Description so screen readers
        announce the dialog as "Workflows" (heading) plus the
        navigation-purpose blurb (review note m-1). The visible
        sidebar title in `SidebarContent` stays a non-heading `<div>`
        to avoid colliding with the index page's `<h1>Workflows</h1>`,
        but the dialog title is scoped to the drawer subtree only and
        therefore safe.
      -->
      <Dialog.Title class="sr-only">
        {copy.mobileDialogTitle}
      </Dialog.Title>
      <Dialog.Description class="sr-only">
        {copy.mobileDialogAria}
      </Dialog.Description>
      <!--
        Close button mirrors the design's icon-button affordance. We
        anchor it to the top-right inside the drawer (rather than
        inside `SidebarContent`) so the file tree stays identical
        between desktop and mobile.
      -->
      <Dialog.Close
        class="absolute top-2 right-2 z-10 flex size-7 items-center justify-center rounded-sm text-(--color-text-secondary) hover:bg-(--color-bg-hover) focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:outline-none"
        aria-label={copy.mobileCloseAria}
      >
        <X class="size-4" aria-hidden="true" />
      </Dialog.Close>
      <SidebarContent
        {workflows}
        onNavigate={() => (open = false)}
      />
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
