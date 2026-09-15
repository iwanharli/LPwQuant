import { useEffect, useState } from "react";
import { ENGINE_URL } from "./format";
import type { ConnectionStatus, LiveMessage, PoolRow } from "./types";

const WS_URL = `${ENGINE_URL.replace(/^http/, "ws")}/ws`;

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
      socket = new WebSocket(WS_URL);
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
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
      };
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
