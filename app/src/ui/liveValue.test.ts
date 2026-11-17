import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { liveValue, useLiveValue, type LiveValue } from "./liveValue";

describe("liveValue", () => {
  test("holds the value it was last set to", () => {
    const v = liveValue(0);
    expect(v.get()).toBe(0);
    v.set(0.25);
    expect(v.get()).toBe(0.25);
  });

  test("tells each reader of a change, and only of a change", () => {
    const v = liveValue<string | null>(null);
    const a = vi.fn();
    const b = vi.fn();
    v.subscribe(a);
    v.subscribe(b);
    v.set("x");
    v.set("x"); // the same value: a hover over the same route, every pointer move
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    v.set(null);
    expect(a).toHaveBeenCalledTimes(2);
  });

  test("stops telling a reader once it unsubscribes", () => {
    const v = liveValue(1);
    const l = vi.fn();
    const off = v.subscribe(l);
    off();
    v.set(2);
    expect(l).not.toHaveBeenCalled();
  });

  test("a reader may unsubscribe while being told", () => {
    const v = liveValue(1);
    const second = vi.fn();
    const off = v.subscribe(() => off());
    v.subscribe(second);
    v.set(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("set is a stable callback, usable detached", () => {
    const v = liveValue<number | null>(null);
    const { set } = v;
    set(3);
    expect(v.get()).toBe(3);
    expect(v.set).toBe(set);
  });

  test("useLiveValue renders the current value", () => {
    const v = liveValue("Morning Run");
    const Reader = ({ live }: { live: LiveValue<string> }) => createElement("span", null, useLiveValue(live));
    expect(renderToStaticMarkup(createElement(Reader, { live: v }))).toBe("<span>Morning Run</span>");
  });
});
