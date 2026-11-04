import { describe, expect, test } from "vitest";
import { loadDetail, parseDetail } from "./detail";

const valid = { v: 1, step: 5, t: [0, 5, 10], hr: [100, null, 110], alt: [300, 301, 302] };

describe("parseDetail", () => {
  test("parses a valid file", () => {
    expect(parseDetail(valid)).toEqual(valid);
  });

  test("rejects v2", () => {
    expect(() => parseDetail({ ...valid, v: 2 })).toThrow(/version 2/);
  });

  test("rejects a length mismatch", () => {
    expect(() => parseDetail({ ...valid, hr: [100, 101] })).toThrow(/hr/);
  });

  test("rejects a non-object", () => {
    expect(() => parseDetail(null)).toThrow();
  });
});

describe("loadDetail", () => {
  test("fetches once per id", async () => {
    let calls = 0;
    const fetchJson = async (url: string) => {
      calls++;
      expect(url).toContain("data/activity/once.json");
      return valid;
    };
    await loadDetail("once", fetchJson);
    await loadDetail("once", fetchJson);
    expect(calls).toBe(1);
  });

  test("a failed load is retried next time", async () => {
    let calls = 0;
    const fetchJson = async () => {
      calls++;
      if (calls === 1) throw new Error("404");
      return valid;
    };
    await expect(loadDetail("flaky", fetchJson)).rejects.toThrow("404");
    await expect(loadDetail("flaky", fetchJson)).resolves.toEqual(valid);
    expect(calls).toBe(2);
  });
});
