import { describe, expect, test, vi } from "vitest";
import { loadProfiles, parseProfiles } from "./routeProfiles";

describe("parseProfiles", () => {
  test("accepts a valid file", () => {
    const f = { v: 1, bins: 3, profiles: { a: [1, 2, 3] } };
    expect(parseProfiles(f)).toBe(f);
  });

  test("refuses an unknown version", () => {
    expect(() => parseProfiles({ v: 2, bins: 3, profiles: {} })).toThrow(/version 2/);
  });

  test("refuses a profile of the wrong length or with non-numbers", () => {
    expect(() => parseProfiles({ v: 1, bins: 3, profiles: { a: [1, 2] } })).toThrow(/profile a/);
    expect(() => parseProfiles({ v: 1, bins: 2, profiles: { a: [1, null] } })).toThrow(/profile a/);
  });

  test("refuses a non-object", () => {
    expect(() => parseProfiles(null)).toThrow();
  });
});

describe("loadProfiles", () => {
  test("fetches once, retries after a failure", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(loadProfiles(failing)).rejects.toThrow("offline");
    const ok = vi.fn().mockResolvedValue({ v: 1, bins: 2, profiles: {} });
    await loadProfiles(ok);
    await loadProfiles(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
