// Keeps the URL's query string on the app's state (urlState.ts), so a copied link or a
// reload shows what was on screen. The hash stays useView's: switching page pushes a
// history entry there, and every other change replaces the current entry here,
// debounced, so a pan, a slider drag or a click through routes never floods the history
// and Back keeps meaning "the previous page". The state isn't history: after a
// back/forward the entry is rewritten with the state as it is now.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUrlState, urlStateOf, type AppUrlState } from "../urlState";
import type { Camera } from "../homeCamera";

/** Quiet time before a write: long enough to skip a drag's steps, short enough to feel live. */
const WRITE_DELAY_MS = 300;

export interface UrlWriter {
  /** Write `search` once no other has been scheduled for the delay. */
  schedule(search: string): void;
  /** Write what is pending now. */
  flush(): void;
  /** Drop what is pending. */
  cancel(): void;
}

/** A debounced writer: only the last of a burst of values is written. */
export function createUrlWriter(write: (search: string) => void, delayMs: number): UrlWriter {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    pending = null;
  };
  const flush = () => {
    const search = pending;
    cancel();
    if (search !== null) write(search);
  };
  return {
    schedule(search) {
      clearTimeout(timer);
      pending = search;
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel,
  };
}

/** Replace the current entry's query string, keeping the path, the hash (the page) and the entry's state. */
function replaceSearch(search: string) {
  const { pathname, hash } = window.location;
  if (window.location.search === search) return;
  try {
    window.history.replaceState(window.history.state, "", pathname + search + hash);
  } catch (e) {
    // Safari throws once a page replaces too often; the next write catches up.
    console.warn(`Couldn't update the URL: ${String(e)}`);
  }
}

/**
 * Write `app` (null until the data is in: until then the incoming link stays as it is)
 * to the URL, with the camera given to the returned setter. The camera is kept in a ref,
 * not state, so a map move re-renders nothing. `initialCamera` is the URL's own, kept
 * until the map reports a move.
 */
export function useUrlSync(
  app: Omit<AppUrlState, "camera"> | null,
  initialCamera: Camera | null,
): (camera: Camera | null) => void {
  const appRef = useRef(app);
  appRef.current = app;
  const cameraRef = useRef(initialCamera);
  const [writer] = useState(() => createUrlWriter(replaceSearch, WRITE_DELAY_MS));

  const schedule = useCallback(() => {
    const a = appRef.current;
    if (a) writer.schedule(formatUrlState(urlStateOf({ ...a, camera: cameraRef.current })));
  }, [writer]);

  useEffect(schedule, [schedule, app?.filter, app?.selectedId, app?.groupOpen, app?.colorMode]);

  useEffect(() => {
    // Back/forward lands on an entry written with an older state: bring it up to date.
    const onPop = () => {
      schedule();
      writer.flush();
    };
    // A reload or a closed tab inside the delay still keeps the last change.
    const onHide = () => writer.flush();
    window.addEventListener("popstate", onPop);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("pagehide", onHide);
      writer.flush();
    };
  }, [schedule, writer]);

  return useCallback(
    (camera: Camera | null) => {
      cameraRef.current = camera;
      schedule();
    },
    [schedule],
  );
}
