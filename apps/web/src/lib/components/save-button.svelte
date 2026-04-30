<!--
  Save button wrapper.

  Pulls the accent fill / hover / shadow styling out of the editor page so
  the look stays consistent with `PatternPicker`'s FAB (`app.pen / Hkw62`)
  and routes through shadcn `Button` (which builds on top of
  `buttonVariants`) instead of bypassing the variant tokens with raw
  className overrides on a vanilla `<button>`. Props are passed through to
  the underlying `Button` so consumers retain `disabled`, `aria-busy`,
  `onclick`, etc.

  This file lives outside `$lib/components/ui/` to comply with the
  shadcn-svelte protection rule — wrappers must not edit the shadcn
  templates directly.
-->
<script lang="ts">
  import { Button, type ButtonProps } from '$lib/components/ui/button';
  import { cn } from '$lib/utils';

  let { class: className, children, ...rest }: ButtonProps = $props();
</script>

<Button
  variant="default"
  size="sm"
  {...rest}
  class={cn(
    // Editor accent palette + 44px touch target on mobile, collapsing to
    // the standard sm height on >=sm where pointer input dominates.
    'h-11 rounded-md bg-(--color-accent) px-3 text-xs font-semibold text-white hover:bg-(--color-accent-hover) focus-visible:ring-(--color-accent) sm:h-9',
    className,
  )}
>
  {@render children?.()}
</Button>
