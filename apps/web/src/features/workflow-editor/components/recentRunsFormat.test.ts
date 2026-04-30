import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRelativeTime,
  statusDotVar,
} from './recentRunsFormat';

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000;

  it('renders seconds for sub-minute deltas', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('5s');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('59s');
  });

  it('renders minutes for sub-hour deltas, rounded down', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1m');
    // 119s should round down to 1m, never up to 2m (don't drift ahead of
    // the wall clock).
    expect(formatRelativeTime(NOW - 119_000, NOW)).toBe('1m');
  });

  it('renders hours for sub-day deltas', () => {
    expect(formatRelativeTime(NOW - 60 * 60 * 1000, NOW)).toBe('1h');
    expect(formatRelativeTime(NOW - 23 * 60 * 60 * 1000, NOW)).toBe('23h');
  });

  it('renders days for ≥1d deltas', () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60 * 1000, NOW)).toBe('1d');
  });

  it('clamps negative deltas to 0s instead of producing nonsense', () => {
    // A clock-skew edge case: server reports a startedAt slightly in the
    // future relative to the client's `Date.now()`.
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('0s');
  });
});

describe('formatDuration', () => {
  it('returns null for in-flight runs', () => {
    expect(formatDuration(null)).toBeNull();
  });

  it('renders milliseconds below 1s', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders fractional seconds below 10s, integer seconds otherwise', () => {
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(9_900)).toBe('9.9s');
    expect(formatDuration(12_000)).toBe('12s');
  });

  it('renders minutes-and-seconds below 1h', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(75_000)).toBe('1m15s');
  });

  it('renders hours-and-minutes for ≥1h durations', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h');
    expect(formatDuration(75 * 60_000)).toBe('1h15m');
  });
});

describe('statusDotVar', () => {
  it('maps each RunStatus to a defined CSS variable', () => {
    // `succeeded` uses the dedicated semantic token instead of the
    // `node-trigger` category tint it previously borrowed (review note m2).
    expect(statusDotVar('succeeded')).toBe('--color-success');
    expect(statusDotVar('failed')).toBe('--color-danger');
    expect(statusDotVar('cancelled')).toBe('--color-danger');
    expect(statusDotVar('running')).toBe('--color-accent');
    expect(statusDotVar('pending')).toBe('--color-accent');
  });
});
