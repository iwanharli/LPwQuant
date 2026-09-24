"use client";

import { useEffect } from "react";

/**
 * Refreshes on a timer, but only while the tab is actually being looked at, and immediately when it is opened
 * again. A dashboard left in a background tab used to keep polling every 10-30 seconds for hours; now it stops,
 * and the first thing that happens on return is a fetch, so what you see is never the stale view from before.
 *
 * `intervalMs` is the steady cadence. The callback must be stable (useCallback) or the timer restarts each render.
 */
export function useAutoRefresh(refresh: () => void, intervalMs: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(refresh, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh(); // coming back: show current data, not what was on screen when the tab was hidden
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, intervalMs, enabled]);
}
