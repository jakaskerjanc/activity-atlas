import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { MapErrorBoundary } from "./MapErrorBoundary";

// Error boundaries don't run under server rendering, so exercise the lifecycle directly.
describe("MapErrorBoundary", () => {
  const make = (onError = () => {}) =>
    new MapErrorBoundary({ children: createElement("canvas"), onError });

  test("renders the map until something throws", () => {
    expect(make().render()).toEqual(createElement("canvas"));
  });

  test("drops the map and reports once it fails", () => {
    const onError = vi.fn();
    const boundary = make(onError);
    boundary.state = MapErrorBoundary.getDerivedStateFromError();
    boundary.componentDidCatch();
    expect(boundary.render()).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });
});
