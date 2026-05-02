<!--
  Save button wrapper.

  Pulls the accent fill / hover / shadow styling out of the editor page so
  the look stays consistent with `PatternPicker`'s FAB (`app.pen / Hkw62`)
  and routes through shadcn `Button` (which builds on top of
  `buttonVariants`) instead of bypassing the variant tokens with raw
  className overrides on a vanilla `<button>`. Props are passed through to
  the underlying `Button` so consumers retain `disabled`, `aria-busy`,
  `onclick`, etc.

  The `compact` prop trades the default 36px (`sm:h-9`) pointer height for
  the Top Bar's 32px (`sm:h-8`) pill so the design's `Ht9Do` 56px row
  invariant survives without consumers having to know how `cn()` orders
  their className override (review-design-topbar-frontend.md M-2). Mobile
  retains the 44px tap target in both modes.

  This file lives outside `$lib/components/ui/` to comply with the
  shadcn-svelte protection rule — wrappers must not edit the shadcn
  templates directly.
-->
<script lang="ts">
  import { Button, type ButtonProps } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';

  let {
    class: className,
    compact = false,
    children,
    ...rest
  }: ButtonProps & {
    /**
     * Top Bar variant. Switches the >=sm height from 36px to 32px and
     * rebases the focus ring offset to `--color-bg-surface` so the
     * keyboard-focus ring stays visible against the Top Bar surface.
     * Mobile (`< sm`) keeps the 44px tap target.
     */
    compact?: boolean;
  } = $props();
</script>

<Button
  variant="default"
  size="sm"
  {...rest}
  class={cn(
    // Editor accent palette + 44px touch target on mobile, collapsing to
    // the standard sm height on >=sm where pointer input dominates.
    //
    // `focus-visible:ring-offset-2` lifts the keyboard-focus ring off
    // the button so it stays visible against the accent fill (the ring
    // colour is the same accent hue and would otherwise blend into the
    // button surface). The offset colour follows the consumer's surface:
    // `--color-bg-app` for the index empty card / canvas FAB context,
    // `--color-bg-topbar` for the Top Bar's surface in `compact` mode
    // (the Top Bar uses its own surface token so the light-theme
    // `#FAFAFA` band stays distinct from the white `--color-bg-surface`
    // used elsewhere — review-design-topbar-frontend.md M-1).
    'h-11 rounded-md bg-(--color-accent) px-3 text-xs font-semibold text-white hover:bg-(--color-accent-hover) focus-visible:ring-(--color-accent) focus-visible:ring-offset-2',
    compact
      ? 'sm:h-8 focus-visible:ring-offset-(--color-bg-topbar)'
      : 'sm:h-9 focus-visible:ring-offset-(--color-bg-app)',
    className,
  )}
>
  {@render children?.()}
</Button>
