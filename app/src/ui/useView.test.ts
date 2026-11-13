import { describe, expect, test } from "vitest";
import { viewFromHash } from "./useView";

describe("viewFromHash", () => {
  test("#analytics opens the analytics page", () => {
    expect(viewFromHash("#analytics")).toBe("analytics");
  });

  test("#activities opens the activities list", () => {
    expect(viewFromHash("#activities")).toBe("activities");
  });

  test("no hash, or one it doesn't know, falls back to the map", () => {
    expect(viewFromHash("")).toBe("map");
    expect(viewFromHash("#")).toBe("map");
    expect(viewFromHash("#nope")).toBe("map");
  });
});
