import { describe, expect, test, vi } from "vitest";
import { loadProfiles, parseProfiles } from "./routeProfiles";

describe("parseProfiles", () => {
  test("accepts a valid file", () => {
    const f = { v: 1, step: 100, profiles: { a: [0, 2, 3] } };
    expect(parseProfiles(f)).toBe(f);
  });

  test("refuses an unknown version", () => {
    expect(() => parseProfiles({ v: 2, step: 100, profiles: {} })).toThrow(/version 2/);
    expect(() => parseProfiles({ v: 1, profiles: {} })).toThrow(/step/);
  });

  test("refuses a profile under two points or with non-numbers", () => {
    expect(() => parseProfiles({ v: 1, step: 100, profiles: { a: [0] } })).toThrow(/profile a/);
    expect(() => parseProfiles({ v: 1, step: 100, profiles: { a: [0, null] } })).toThrow(/profile a/);
  });

  test("refuses a non-object", () => {
    expect(() => parseProfiles(null)).toThrow();
  });
});

describe("loadProfiles", () => {
  test("fetches once, retries after a failure", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(loadProfiles(failing)).rejects.toThrow("offline");
    const ok = vi.fn().mockResolvedValue({ v: 1, step: 100, profiles: {} });
    await loadProfiles(ok);
    await loadProfiles(ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
