/**
 * Render a running train on a rail track. The train slides left-to-right and
 * wraps around, and the landscape behind it changes over time — plain rail,
 * sea, mountains, or a tunnel — so the heartbeat feels like an actual
 * journey rather than a repeating loop.
 *
 *   ` 🚂━━━━━━━━━━━ `   (plain track)
 *   `🌊🌊🚂🌊🌊🌊🌊`   (sea crossing)
 *   `⛰⛰⛰🚂⛰⛰⛰`   (mountain pass)
 *   `══════🚂══════`   (tunnel)
 */
type Scenery = {
  cell: string;
  /** Terminal cell width of `cell`. The train (🚂) is 2 cells wide. */
  cellWidth: 1 | 2;
  label: 'plain' | 'sea' | 'mountain' | 'tunnel';
};

/** Target rendered width in terminal cells. `trackLen` is derived per scenery
 *  so plain/sea/mountain/tunnel all occupy the same on-screen width. */
const LAP_VISIBLE_WIDTH = 30;
/** Wall-clock duration of one full lap, regardless of scenery's trackLen.
 *  Keeps the train's apparent speed constant across scenery changes. */
const LAP_DURATION_MS = 5400;

function sceneryForLap(lap: number): Scenery {
  // Weighted draw: plain rail dominates, with occasional sea / mountain /
  // tunnel laps. 12 slots total — 0..5 plain, 6..7 sea, 8..9 mountain, 10..11 tunnel.
  const slot = Math.abs(Math.imul(lap + 1, 2654435761)) % 12;
  if (slot <= 5) return { cell: '━', cellWidth: 1, label: 'plain' };
  if (slot <= 7) return { cell: '\u{1F30A}', cellWidth: 2, label: 'sea' }; // 🌊
  if (slot <= 9) return { cell: '⛰', cellWidth: 1, label: 'mountain' };
  return { cell: '═', cellWidth: 1, label: 'tunnel' };
}

function trackLenFor(cellWidth: 1 | 2): number {
  // Visible width = (trackLen - 1) * cellWidth + 2 (train is 2 cells wide).
  return Math.max(2, Math.round((LAP_VISIBLE_WIDTH - 2) / cellWidth) + 1);
}

export function trainLine(now = Date.now()): string {
  const lap = Math.floor(now / LAP_DURATION_MS);
  const scenery = sceneryForLap(lap);
  const trackLen = trackLenFor(scenery.cellWidth);
  const phase = (now % LAP_DURATION_MS) / LAP_DURATION_MS;
  const pos = Math.floor(phase * trackLen);
  const cells: string[] = new Array(trackLen).fill(scenery.cell);
  cells[pos] = '\u{1F682}'; // 🚂
  return cells.join('');
}
