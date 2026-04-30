// Route-layer unit tests for the shared insert-pattern failure handling.
//
// Both `routes/workflows/[id]/+page.server.ts` (form action) and
// `routes/api/workflows/[id]/patterns/+server.ts` (REST endpoint) funnel
// non-success outputs through `handleInsertPatternFailure`. These tests pin
// the status-code mapping so a refactor of `mapInsertPatternFailure` cannot
// silently change the contract observed by both surfaces.
//
// We don't spin up SvelteKit's actual handler here: doing so would require
// `@sveltejs/kit/test` plumbing for very limited extra coverage. The route
// files themselves are thin wiring (parse params, call workflow, hand off to
// `handleInsertPatternFailure`); the workflow has its own exhaustive tests
// and `handleInsertPatternFailure` is what links the two.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInsertPatternFailure } from './insertPatternRoute';
import type { InsertPatternOutput } from '../workflows/insertPatternWorkflow';

type Failure = Exclude<InsertPatternOutput, { kind: 'patternInserted' }>;

const ctx = { workflowId: 'demo.yaml', patternId: 'set' } as const;

describe('handleInsertPatternFailure', () => {
  // Silence the structured logs the handler emits; we still assert *what*
  // gets logged for the variants that have to be observable in production.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it.each<[Failure, number, string]>([
    [{ kind: 'workflowNotFound' }, 404, 'workflow not found'],
    [{ kind: 'unknownPattern' }, 404, 'unknown pattern'],
    [{ kind: 'unsupportedPattern' }, 409, 'pattern is not supported by the runtime'],
    // The user-facing message is intentionally a prefix + recovery hint so
    // the bare technical phrase still passes substring matchers in the e2e
    // suite while the picker shows a recovery instruction (review note m2).
    [
      { kind: 'idConflict' },
      409,
      'unable to allocate unique task ids — your workflow has many steps with the same name. Rename a few existing steps before retrying.',
    ],
    [{ kind: 'invalidBaseYaml', reason: 'bad' }, 422, 'base workflow YAML is invalid'],
    [
      { kind: 'templateMalformed', reason: 'pattern entry must have exactly one key (got 2)' },
      500,
      'pattern template registry is malformed',
    ],
    [{ kind: 'persistFailed', reason: 'invalid extension: a.txt' }, 500, 'failed to persist workflow'],
  ])(
    'maps %j to status %i with message %j',
    (variant, expectedStatus, expectedMessage) => {
      const out = handleInsertPatternFailure(variant, ctx);
      expect(out).toEqual({ status: expectedStatus, message: expectedMessage });
    },
  );

  it('does not leak `reason` strings into the user-facing message', () => {
    // Regression: an earlier prototype interpolated `result.reason` into the
    // outgoing message. We deliberately keep the messages stable / generic so
    // upstream `assertValidId` text never reaches the client.
    const out = handleInsertPatternFailure(
      { kind: 'persistFailed', reason: '/etc/passwd is not writable' },
      ctx,
    );
    expect(out.message).not.toContain('/etc/passwd');
    // …but the same reason MUST surface in the server log so operators can
    // diagnose without reproducing the failure.
    expect(errorSpy).toHaveBeenCalledWith(
      '[insertPattern] persistFailed',
      expect.objectContaining({ reason: '/etc/passwd is not writable' }),
    );
  });

  it('logs invalidBaseYaml at warn level (user-recoverable)', () => {
    handleInsertPatternFailure({ kind: 'invalidBaseYaml', reason: 'bad indent' }, ctx);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs templateMalformed at error level (server-side bug)', () => {
    handleInsertPatternFailure(
      { kind: 'templateMalformed', reason: 'registry has zero-key entry' },
      ctx,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not log for purely status-coded outcomes', () => {
    handleInsertPatternFailure({ kind: 'workflowNotFound' }, ctx);
    handleInsertPatternFailure({ kind: 'unsupportedPattern' }, ctx);
    handleInsertPatternFailure({ kind: 'idConflict' }, ctx);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs unknownPattern at warn level so probes are visible (review note m-5)', () => {
    handleInsertPatternFailure({ kind: 'unknownPattern' }, ctx);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[insertPattern] unknownPattern',
      expect.objectContaining({ workflowId: ctx.workflowId, patternId: ctx.patternId }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
