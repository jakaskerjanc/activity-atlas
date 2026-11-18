// The Activities list's window: which rows it draws beyond the ones on screen, and
// which row the arrow keys move to. Pure, so the list's keyboard rules are testable
// without a browser.

/**
 * The rows to draw: `indexes` (the window) plus the pinned rows (the focused row and
 * the open one, which must stay mounted while scrolled away), ascending, once each.
 * Nulls and indexes outside `0..count-1` are dropped.
 */
export function withPinned(indexes: number[], pinned: readonly (number | null | undefined)[], count: number): number[] {
  const extra = pinned.filter(
    (i): i is number => i != null && Number.isInteger(i) && i >= 0 && i < count && !indexes.includes(i),
  );
  if (extra.length === 0) return indexes;
  return [...indexes, ...new Set(extra)].sort((a, b) => a - b);
}

/** The row an arrow key moves to from row `i`, or -1 for the search box (up from row 0). */
export function nextRowIndex(i: number, key: "ArrowDown" | "ArrowUp", count: number): number {
  if (key === "ArrowDown") return Math.min(i + 1, count - 1);
  return i - 1;
}
