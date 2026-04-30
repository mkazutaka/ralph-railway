import type { PatternId } from './types';
import type { TaskEntry } from './workflowDocument';

// PatternTemplate describes a reusable workflow snippet that can be inserted
// into the user's editing buffer. `tasks` is the ordered list of `do` entries
// that the template contributes; each entry's single key is a *base ID*. The
// merge step renames base IDs as needed to avoid collisions.
export interface PatternTemplate {
  readonly id: PatternId;
  readonly label: string;
  readonly description: string;
  readonly supported: boolean;
  readonly tasks: ReadonlyArray<TaskEntry>;
}
