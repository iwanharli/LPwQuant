import { useEffect, useState } from "react";
import { ENGINE_URL } from "./format";
import type { ConnectionStatus, LiveMessage, PoolRow } from "./types";

/** Absolute ws:// URL for the engine's stream. With the same-origin proxy (ENGINE_URL = "/api/engine") the socket
 * cannot go through a route handler, so nginx forwards /ws to the engine after checking the login session. */
function wsUrl(): string {
  if (ENGINE_URL.startsWith("http")) return `${ENGINE_URL.replace(/^http/, "ws")}/ws`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/** Pool rows kept in sync with the engine websocket, reconnecting with backoff. */
export function useLivePools() {
  const [pools, setPools] = useState<Map<string, PoolRow>>(new Map());
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      socket = new WebSocket(wsUrl());
      socket.onopen = () => {
        retry = 0;
        setStatus("live");
      };
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data) as LiveMessage;
        setLastMessageAt(Date.now());
        if (msg.type === "snapshot") {
          setPools(new Map(msg.pools.map((p) => [p.address, p])));
        } else {
          setPools((prev) => {
            const next = new Map(prev);
            for (const p of msg.pools) next.set(p.address, p);
            return next;
          });
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setStatus("offline");
        void snapshot(); // the socket may be blocked entirely; the page should still show pools
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
      };
    };

    // Fallback for when the socket cannot connect at all: one plain fetch of the same rows.
    const snapshot = async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/pools`);
        if (!res.ok) return;
        const body = (await res.json()) as { pools: PoolRow[] };
        if (disposed) return;
        setPools(new Map(body.pools.map((p) => [p.address, p])));
        setLastMessageAt(Date.now());
      } catch {
        // offline: the status pill already says so
      }
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { pools, status, lastMessageAt };
}
