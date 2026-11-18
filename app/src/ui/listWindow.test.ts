import { describe, expect, test } from "vitest";
import { nextRowIndex, withPinned } from "./listWindow";

describe("withPinned", () => {
  test("adds pinned rows in order, once", () => {
    expect(withPinned([10, 11, 12], [3, 11, null], 100)).toEqual([3, 10, 11, 12]);
    expect(withPinned([10, 11], [3, 3], 100)).toEqual([3, 10, 11]);
  });

  test("drops pinned rows outside the list", () => {
    expect(withPinned([0, 1], [500, -1, undefined], 100)).toEqual([0, 1]);
  });
});

describe("nextRowIndex", () => {
  test("stops at the last row and leaves the first for the search box", () => {
    expect(nextRowIndex(4, "ArrowDown", 5)).toBe(4);
    expect(nextRowIndex(3, "ArrowDown", 5)).toBe(4);
    expect(nextRowIndex(0, "ArrowUp", 5)).toBe(-1);
    expect(nextRowIndex(2, "ArrowUp", 5)).toBe(1);
  });
});
