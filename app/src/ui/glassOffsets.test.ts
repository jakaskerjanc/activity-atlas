import { describe, expect, test } from "vitest";
import { glassOffsets } from "./glassOffsets";

describe("glassOffsets", () => {
  test("pushes a top-left anchor down and right by half the panel", () => {
    expect(glassOffsets({ top: 82, left: 24 }, { w: 296, h: 400 })).toEqual({
      top: "282px",
      left: "172px",
    });
  });

  test("expresses a bottom anchor as a top offset, centered horizontally", () => {
    expect(
      glassOffsets({ bottom: 24, centerX: true }, { w: 420, h: 160 }),
    ).toEqual({ top: "calc(100% - 104px)", left: "50%" });
  });

  test("never emits bottom or right, which the rim layers would ignore", () => {
    for (const anchor of [
      { top: 82, left: 24 } as const,
      { bottom: 24, centerX: true } as const,
    ]) {
      const o = glassOffsets(anchor, { w: 300, h: 200 });
      expect(Object.keys(o).sort()).toEqual(["left", "top"]);
    }
  });

  test("emits strings, since the library treats a falsy top/left as unset", () => {
    const o = glassOffsets({ top: 0, left: 0 }, { w: 0, h: 0 });
    expect(o).toEqual({ top: "0px", left: "0px" });
  });

  test("is an identity on the anchor when the panel has not been measured yet", () => {
    expect(glassOffsets({ top: 82, left: 24 }, { w: 0, h: 0 })).toEqual({
      top: "82px",
      left: "24px",
    });
  });

  test("halves odd sizes without rounding", () => {
    expect(glassOffsets({ top: 10, left: 10 }, { w: 21, h: 21 })).toEqual({
      top: "20.5px",
      left: "20.5px",
    });
  });
});
