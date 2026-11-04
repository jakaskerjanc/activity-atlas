// Track an element's content width with ResizeObserver, so SVG charts can draw at
// real pixel size (no stretched strokes or text). `fallback` is used until the first
// measurement, and for server rendering in tests.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export function useElementWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(el.clientWidth || fallback);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}
