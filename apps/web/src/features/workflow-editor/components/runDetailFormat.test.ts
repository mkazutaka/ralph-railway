import { describe, expect, it } from 'vitest';
import {
  computeNodeDurationMs,
  computeRunDurationMs,
  formatStartedAt,
  nodeStatusDotVar,
  nodeStatusLabel,
  runStatusDotVar,
  runStatusLabel,
  runStatusToneVar,
} from './runDetailFormat';

describe('runStatusDotVar', () => {
  it('maps each RunStatus to a defined CSS variable', () => {
    expect(runStatusDotVar('succeeded')).toBe('--color-success');
    expect(runStatusDotVar('failed')).toBe('--color-danger');
    expect(runStatusDotVar('cancelled')).toBe('--color-danger');
    expect(runStatusDotVar('running')).toBe('--color-accent');
    expect(runStatusDotVar('pending')).toBe('--color-accent');
  });
});

describe('nodeStatusDotVar', () => {
  it('extends the run mapping with a muted "skipped" tint', () => {
    expect(nodeStatusDotVar('succeeded')).toBe('--color-success');
    expect(nodeStatusDotVar('failed')).toBe('--color-danger');
    expect(nodeStatusDotVar('cancelled')).toBe('--color-danger');
    expect(nodeStatusDotVar('running')).toBe('--color-accent');
    expect(nodeStatusDotVar('pending')).toBe('--color-accent');
    // skipped uses the tertiary text token (de-emphasised)
    expect(nodeStatusDotVar('skipped')).toBe('--color-text-tertiary');
  });
});

describe('runStatusLabel', () => {
  it('returns the capitalised noun for every RunStatus', () => {
    expect(runStatusLabel('succeeded')).toBe('Success');
    expect(runStatusLabel('failed')).toBe('Failed');
    expect(runStatusLabel('cancelled')).toBe('Cancelled');
    expect(runStatusLabel('running')).toBe('Running');
    expect(runStatusLabel('pending')).toBe('Pending');
  });
});

describe('nodeStatusLabel', () => {
  it('returns a noun for every NodeRunStatus including skipped', () => {
    expect(nodeStatusLabel('succeeded')).toBe('Succeeded');
    expect(nodeStatusLabel('failed')).toBe('Failed');
    expect(nodeStatusLabel('cancelled')).toBe('Cancelled');
    expect(nodeStatusLabel('skipped')).toBe('Skipped');
    expect(nodeStatusLabel('running')).toBe('Running');
    expect(nodeStatusLabel('pending')).toBe('Pending');
  });
});

describe('runStatusToneVar', () => {
  it('returns the foreground colour token for the run status badge', () => {
    expect(runStatusToneVar('succeeded')).toBe('--color-success');
    expect(runStatusToneVar('failed')).toBe('--color-danger');
    expect(runStatusToneVar('cancelled')).toBe('--color-danger');
    expect(runStatusToneVar('running')).toBe('--color-accent');
    expect(runStatusToneVar('pending')).toBe('--color-accent');
  });
});

describe('computeRunDurationMs', () => {
  it('returns null while the run is in flight', () => {
    expect(computeRunDurationMs(1_000, null)).toBeNull();
  });

  it('returns endedAt - startedAt for terminal runs', () => {
    expect(computeRunDurationMs(1_000, 4_500)).toBe(3_500);
    expect(computeRunDurationMs(1_000, 1_000)).toBe(0);
  });

  it('clamps to 0 if the store accidentally yields endedAt < startedAt', () => {
    // `buildRunDetailFromRow` rejects this in production but the formatter
    // must not amplify the regression by emitting negative time.
    expect(computeRunDurationMs(2_000, 1_000)).toBe(0);
  });
});

describe('computeNodeDurationMs', () => {
  it('returns null when either bound is missing (pending / running / never-started)', () => {
    expect(computeNodeDurationMs(null, null)).toBeNull();
    expect(computeNodeDurationMs(1_000, null)).toBeNull();
    expect(computeNodeDurationMs(null, 1_000)).toBeNull();
  });

  it('returns the delta when both bounds are present', () => {
    expect(computeNodeDurationMs(1_000, 1_500)).toBe(500);
  });

  it('clamps negative deltas to 0', () => {
    expect(computeNodeDurationMs(2_000, 1_500)).toBe(0);
  });
});

describe('formatStartedAt', () => {
  it('produces a non-empty wall-clock string for a valid epoch', () => {
    const out = formatStartedAt(1_700_000_000_000);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
