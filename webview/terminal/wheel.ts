/**
 * Convert one wheel event into signed terminal lines.
 *
 * Kept dependency-free so the unit test can run in Node without xterm's DOM.
 */
export function wheelScrollLines(deltaY: number, deltaMode: number, rows: number): number {
  const magnitude = Math.abs(deltaY);
  if (magnitude === 0) {
    return 0;
  }
  let lines: number;
  if (deltaMode === 1) {
    // DOM_DELTA_LINE
    lines = magnitude;
  } else if (deltaMode === 2) {
    // DOM_DELTA_PAGE
    lines = magnitude * Math.max(1, rows);
  } else {
    // Pixel deltas: one 100px wheel notch is about three rows, matching the
    // integrated terminal's default feel.
    lines = Math.max(1, Math.round(magnitude / 33));
  }
  return deltaY < 0 ? -lines : lines;
}
