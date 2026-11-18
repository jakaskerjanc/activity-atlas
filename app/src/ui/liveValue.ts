// A value that changes many times a second: the replay's progress (every frame), the
// cursor (every pointer move over a chart or the selected route) and the hovered route.
// Held outside React state, so setting one re-renders only the components that read it
// (useLiveValue), not App and every panel under it. App keeps one of each and hands it
// down; whoever only sets it or reads it in a handler uses get/set and never re-renders.

import { useSyncExternalStore } from "react";

export interface LiveValue<T> {
  get(): T;
  /** Tells the readers only when the value actually changes (Object.is). */
  set(next: T): void;
  /** Called after each change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function liveValue<T>(initial: T): LiveValue<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  // Plain closures rather than methods, so `live.set` can be handed on as a callback
  // and stays the same function for the value's life.
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The value now, re-rendering the caller (only) when it changes. */
export function useLiveValue<T>(live: LiveValue<T>): T {
  // The same snapshot on the server, where the tests render.
  return useSyncExternalStore(live.subscribe, live.get, live.get);
}
