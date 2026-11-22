import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createUrlWriter } from "./useUrlSync";

describe("createUrlWriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("writes once the changes stop, with the last value", () => {
    const writes: string[] = [];
    const w = createUrlWriter((s) => writes.push(s), 300);
    w.schedule("?a=1");
    vi.advanceTimersByTime(200);
    w.schedule("?a=2");
    vi.advanceTimersByTime(299);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual(["?a=2"]);
  });

  test("flush writes what is pending at once, and only once", () => {
    const writes: string[] = [];
    const w = createUrlWriter((s) => writes.push(s), 300);
    w.schedule("?a=1");
    w.flush();
    expect(writes).toEqual(["?a=1"]);
    vi.advanceTimersByTime(1000);
    w.flush();
    expect(writes).toEqual(["?a=1"]);
  });

  test("flush with nothing pending writes nothing", () => {
    const writes: string[] = [];
    createUrlWriter((s) => writes.push(s), 300).flush();
    expect(writes).toEqual([]);
  });

  test("cancel drops what is pending", () => {
    const writes: string[] = [];
    const w = createUrlWriter((s) => writes.push(s), 300);
    w.schedule("?a=1");
    w.cancel();
    vi.advanceTimersByTime(1000);
    expect(writes).toEqual([]);
  });
});
