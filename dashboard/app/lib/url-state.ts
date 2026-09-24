"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A piece of view state kept in the URL, so a refresh (or a shared link) lands on the same sub-view.
 *
 * The URL is an external store, so it is read through useSyncExternalStore: the server snapshot is null, which
 * makes the first paint match the server's HTML, and the browser then reads the real query string. Updates use
 * replaceState, so switching sub-views does not pile up history entries.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function useUrlState<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(key),
    () => null,
  );
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const set = useCallback(
    (next: T) => {
      const params = new URLSearchParams(window.location.search);
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      listeners.forEach((l) => l());
    },
    [key, fallback],
  );

  return [value, set];
}
