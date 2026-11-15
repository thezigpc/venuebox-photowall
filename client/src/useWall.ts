// The wall, polled. A TV runs for days, so this never gives up and never shows an error: a
// failed poll keeps the last good wall (also in localStorage, so a TV that reloads during an
// outage still has its photos).

import { useEffect, useState } from "react";
import { bgUrl } from "@bargames/sdk/client";
import type { Wall } from "@photowall/shared";

const STORE_KEY = "photowall.lastWall";

function loadSaved(): Wall | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Wall) : null;
  } catch {
    return null;
  }
}

function save(w: Wall): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(w));
  } catch {
    /* full or blocked: memory only */
  }
}

export function useWall(opts: { intervalMs: number; reloadOnNewBuild: boolean }): Wall | null {
  const [wall, setWall] = useState<Wall | null>(loadSaved);

  useEffect(() => {
    let etag = "";
    let firstBuild = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;

    const tick = async () => {
      try {
        const res = await fetch(bgUrl("/api/wall"), { cache: "no-store", headers: etag ? { "if-none-match": etag } : {} });
        if (res.status === 200) {
          const w = (await res.json()) as Wall;
          etag = res.headers.get("etag") ?? "";
          if (!firstBuild) firstBuild = w.build;
          else if (opts.reloadOnNewBuild && w.build !== firstBuild && w.build !== "dev") {
            location.reload(); // the server was updated: load the new client
            return;
          }
          save(w);
          if (!stopped) setWall(w);
        }
        failures = 0;
      } catch {
        failures++;
      }
      if (stopped) return;
      const wait = failures ? Math.min(60_000, opts.intervalMs * 2 ** Math.min(failures, 4)) : opts.intervalMs;
      timer = setTimeout(tick, wait);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [opts.intervalMs, opts.reloadOnNewBuild]);

  return wall;
}

export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
