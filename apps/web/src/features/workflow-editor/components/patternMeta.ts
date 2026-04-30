// UI-only metadata for the pattern showcase. Mirrors the design tokens used
// in design/app.pen (Add Node popup): each pattern is presented with a
// lucide icon, a short monospace subtitle, and a colour family.

import Sparkles from 'lucide-svelte/icons/sparkles';
import GitBranch from 'lucide-svelte/icons/git-branch';
import GitFork from 'lucide-svelte/icons/git-fork';
import Repeat from 'lucide-svelte/icons/repeat';
import Shuffle from 'lucide-svelte/icons/shuffle';
import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
import Shield from 'lucide-svelte/icons/shield';
import ListChecks from 'lucide-svelte/icons/list-checks';
import Variable from 'lucide-svelte/icons/variable';
// lucide-svelte v1 ships legacy class components, so we just borrow the
// concrete type of one of the icons to describe the constructor shape.
export type IconComponent = typeof Sparkles;

export interface PatternMeta {
  readonly icon: IconComponent;
  readonly subtitle: string;
  /** Tailwind class controlling the icon tint. */
  readonly tone: string;
}

const FALLBACK: PatternMeta = {
  icon: Sparkles,
  subtitle: '',
  tone: 'text-violet-300',
};

const TABLE: Record<string, PatternMeta> = {
  do: { icon: ListChecks, subtitle: 'do: [...]', tone: 'text-sky-300' },
  if: { icon: GitBranch, subtitle: 'if: ${...}', tone: 'text-violet-300' },
  switch: { icon: Shuffle, subtitle: 'switch.cases', tone: 'text-violet-300' },
  fork: { icon: GitFork, subtitle: 'fork.branches', tone: 'text-violet-300' },
  loop: { icon: Repeat, subtitle: 'for / each', tone: 'text-violet-300' },
  try: { icon: Shield, subtitle: 'try / catch', tone: 'text-amber-300' },
  retry: { icon: RotateCcw, subtitle: 'retry.max', tone: 'text-amber-300' },
  set: { icon: Variable, subtitle: 'set: { ... }', tone: 'text-emerald-300' },
};

// Dev-only telemetry: track which unknown ids we've already warned about so
// the console doesn't fill with duplicate messages while the user scrolls
// the showcase. Module-scoped Set is fine because the showcase list is
// small (<32 ids) and the Set is reset on full reload.
const WARNED_UNKNOWN_IDS = new Set<string>();

export function patternMetaFor(id: string): PatternMeta {
  const hit = TABLE[id];
  if (hit) return hit;
  // Surface a one-shot warning in dev so a freshly-added server-side
  // pattern that lacks UI metadata is noticeable instead of silently
  // falling back to the Sparkles icon (review note m8). The check is
  // gated on `import.meta.env.DEV` so production bundles stay quiet.
  if (import.meta.env.DEV && !WARNED_UNKNOWN_IDS.has(id)) {
    WARNED_UNKNOWN_IDS.add(id);
    console.warn(
      `[patternMeta] no UI metadata registered for pattern id "${id}" — falling back to Sparkles. Add it to TABLE in patternMeta.ts.`,
    );
  }
  return FALLBACK;
}
