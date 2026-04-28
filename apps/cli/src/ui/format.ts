// src/ui/format.ts

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}m${rs.toString().padStart(2, '0')}s`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m.toString().padStart(2, '0')}:${rs.toString().padStart(2, '0')}`;
}

export function formatTotalElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${rs.toString().padStart(2, '0')}s`;
  return `${m.toString().padStart(2, '0')}:${rs.toString().padStart(2, '0')}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Split text on newlines, then hard-wrap each non-empty line at `max` chars.
 * Empty lines are dropped so the renderer doesn't show blank rows.
 */
export function wrapLines(text: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue;
    for (let i = 0; i < raw.length; i += max) out.push(raw.slice(i, i + max));
  }
  return out;
}
