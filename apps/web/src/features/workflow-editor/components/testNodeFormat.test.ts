import { describe, expect, it } from 'vitest';
import {
  formatTestDuration,
  testNodeStatusDotVar,
  testNodeStatusLabel,
  testNodeStatusToneVar,
} from './testNodeFormat';

describe('testNodeStatusDotVar', () => {
  it('maps both terminal NodeTestStatus values to defined CSS variables', () => {
    expect(testNodeStatusDotVar('succeeded')).toBe('--color-success');
    expect(testNodeStatusDotVar('failed')).toBe('--color-danger');
  });
});

describe('testNodeStatusLabel', () => {
  it('returns the capitalised noun for both NodeTestStatus values', () => {
    expect(testNodeStatusLabel('succeeded')).toBe('Succeeded');
    expect(testNodeStatusLabel('failed')).toBe('Failed');
  });
});

describe('testNodeStatusToneVar', () => {
  it('returns the foreground colour token for the result badge', () => {
    expect(testNodeStatusToneVar('succeeded')).toBe('--color-success');
    expect(testNodeStatusToneVar('failed')).toBe('--color-danger');
  });
});

describe('formatTestDuration', () => {
  it('renders milliseconds below 1s', () => {
    expect(formatTestDuration(0)).toBe('0ms');
    expect(formatTestDuration(250)).toBe('250ms');
    expect(formatTestDuration(999)).toBe('999ms');
  });

  it('renders fractional seconds below 10s, integer seconds otherwise', () => {
    expect(formatTestDuration(1_500)).toBe('1.5s');
    expect(formatTestDuration(9_900)).toBe('9.9s');
    expect(formatTestDuration(12_000)).toBe('12s');
  });

  it('renders minutes-and-seconds below 1h', () => {
    expect(formatTestDuration(60_000)).toBe('1m');
    expect(formatTestDuration(75_000)).toBe('1m15s');
  });

  it('renders hours-and-minutes for ≥1h durations', () => {
    expect(formatTestDuration(60 * 60_000)).toBe('1h');
    expect(formatTestDuration(75 * 60_000)).toBe('1h15m');
  });

  it('clamps non-finite or negative values to 0ms', () => {
    expect(formatTestDuration(-1)).toBe('0ms');
    expect(formatTestDuration(Number.NaN)).toBe('0ms');
    expect(formatTestDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
  });
});
