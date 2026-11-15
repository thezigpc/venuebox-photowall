// /tv: the slideshow of approved photos, cast to the bar's TVs. Nobody can touch it, it runs
// for days, and it must never show an error: it keeps the last good wall through network
// blips, skips photos that won't load, and reloads itself when the server is updated.

import { useCallback, useEffect, useRef, useState } from "react";
import { JoinAddress, shortAddress } from "@bargames/gamekit/client";
import { activeAnnouncement, basePath, bgUrl, getVenue, isOnBox, joinDisplay, tableMode, type VenueContext } from "@bargames/sdk/client";
import { initialRotation, nextPhoto, type RotationState, type Wall, type WallPhoto } from "@photowall/shared";
import { Qr } from "../Qr";
import { useNow, useWall } from "../useWall";
import { useVenue } from "../useVenue";

interface Layer {
  key: number;
  photo: WallPhoto | null;
  /** No fade for the very first one. */
  fade: boolean;
}

const FADE_MS = 1200;
const RETRY_MS = 60_000;

function preload(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), 15_000);
    img.onload = () => {
      clearTimeout(t);
      // decode() so the crossfade doesn't stutter on a big photo.
      (img.decode ? img.decode().catch(() => undefined) : Promise.resolve()).then(() => resolve(true));
    };
    img.onerror = () => {
      clearTimeout(t);
      resolve(false);
    };
    img.src = url;
  });
}

function useSlideshow(wall: Wall | null): Layer[] {
  const [layers, setLayers] = useState<Layer[]>([]);
  const ref = useRef(wall);
  ref.current = wall;
  const rotation = useRef<RotationState>(initialRotation());
  const current = useRef<string | null | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const cleanup = useRef<ReturnType<typeof setTimeout>>();
  const failed = useRef(new Map<string, number>());
  const seq = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);

  const show = useCallback((photo: WallPhoto | null) => {
    const id = photo?.id ?? null;
    if (current.current !== id) {
      const layer: Layer = { key: ++seq.current, photo, fade: current.current !== undefined };
      setLayers((prev) => [...prev.slice(-1), layer]);
      clearTimeout(cleanup.current);
      cleanup.current = setTimeout(() => setLayers((prev) => prev.slice(-1)), FADE_MS + 300);
    }
    current.current = id;
  }, []);

  const advance = useCallback(async () => {
    if (busy.current || !alive.current) return;
    const w = ref.current;
    if (!w) return;
    busy.current = true;
    clearTimeout(timer.current);
    try {
      for (const [id, at] of failed.current) if (Date.now() - at > RETRY_MS) failed.current.delete(id);
      let usable = w.photos.filter((p) => !failed.current.has(p.id));
      let picked: WallPhoto | null = null;
      // Try photos until one loads (each failure is skipped for a minute).
      while (usable.length) {
        const r = nextPhoto(rotation.current, usable, w.pinnedWeight);
        rotation.current = r.state;
        const p = usable.find((x) => x.id === r.id) ?? null;
        if (!p) break;
        if (await preload(bgUrl(p.url))) {
          picked = p;
          break;
        }
        failed.current.set(p.id, Date.now());
        usable = usable.filter((x) => x.id !== p.id);
      }
      if (!alive.current) return;
      // Photos exist but none loads (network down, not cached): keep what's on screen.
      if (!picked && w.photos.length > 0 && current.current) {
        timer.current = setTimeout(() => void advance(), 10_000);
        return;
      }
      show(picked);
      timer.current = setTimeout(() => void advance(), (ref.current?.slideSeconds ?? w.slideSeconds) * 1000);
    } finally {
      busy.current = false;
    }
  }, [show]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      clearTimeout(cleanup.current);
    };
  }, []);

  // Start once there's a wall; react at once to a new approval, a removal or an emptied wall.
  useEffect(() => {
    if (!wall) return;
    const cur = current.current;
    const ids = new Set(wall.photos.map((p) => p.id));
    const seen = new Set(rotation.current.seen);
    const fresh = wall.photos.some((p) => !seen.has(p.id));
    const gone = cur !== undefined && cur !== null && !ids.has(cur);
    const wasEmpty = cur === null && wall.photos.length > 0;
    const nowEmpty = wall.photos.length === 0 && cur !== null;
    // A new photo on a wall that's been running waits for the current slide to finish (unless
    // the screen is empty); anything that makes the screen wrong changes it now.
    if (cur === undefined || gone || wasEmpty || nowEmpty) void advance();
    else if (fresh && wall.photos.length === 1) void advance();
    else if (cur) {
      // A caption/name setting changed: redraw the current photo with the new text.
      const p = wall.photos.find((x) => x.id === cur);
      setLayers((prev) => prev.map((l, i) => (i === prev.length - 1 && l.photo && p ? { ...l, photo: p } : l)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall?.version]);

  return layers;
}

/** Box: the SDK's table mode (pointer, wake lock, shared-screen marker). Standalone: our own wake lock. */
function useTvChrome() {
  useEffect(() => {
    let stopped = false;
    let undo: (() => void) | undefined;
    document.documentElement.classList.add("tv-root");
    void getVenue().then((ctx) => {
      if (stopped) return;
      if (isOnBox(ctx)) {
        const tm = tableMode(ctx);
        undo = () => tm.stop();
        return;
      }
      type Sentinel = { release(): Promise<void> };
      const nav = navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<Sentinel> } };
      if (!nav.wakeLock) return;
      let lock: Sentinel | undefined;
      const take = () => {
        if (document.visibilityState === "visible") nav.wakeLock!.request("screen").then((l) => (lock = l), () => undefined);
      };
      take();
      document.addEventListener("visibilitychange", take);
      undo = () => {
        document.removeEventListener("visibilitychange", take);
        void lock?.release().catch(() => undefined);
      };
    });
    return () => {
      stopped = true;
      undo?.();
      document.documentElement.classList.remove("tv-root");
    };
  }, []);
}

/** Where phones go to send a photo: the venue's address for this app on a box, this server otherwise. */
function sendAddress(venue: VenueContext | null): { url: string; short: string } {
  if (isOnBox(venue)) {
    const d = joinDisplay(venue, "/");
    return { url: d.url, short: d.short };
  }
  const url = `${location.origin}${basePath()}/`;
  return { url, short: shortAddress(url) };
}

function Caption({ photo }: { photo: WallPhoto }) {
  if (!photo.caption && !photo.name) return null;
  return (
    <div className="tv-caption">
      {photo.caption && <span className="tv-caption-text">{photo.caption}</span>}
      {photo.name && <span className="tv-caption-name">{photo.caption ? `— ${photo.name}` : `From ${photo.name}`}</span>}
    </div>
  );
}

function PhotoSlide({ photo }: { photo: WallPhoto }) {
  const src = bgUrl(photo.url);
  return (
    <>
      {/* The same photo, blurred, fills the sides of portrait shots instead of black bars. */}
      <div className="tv-backdrop" style={{ backgroundImage: `url("${src}")` }} />
      <img className="tv-photo" src={src} alt="" />
      <Caption photo={photo} />
    </>
  );
}

function BeTheFirst({ name, address, paused, logo }: { name: string; address: { url: string; short: string }; paused: boolean; logo?: string }) {
  return (
    <div className="tv-empty">
      <div className="tv-empty-text">
        {logo ? <img className="tv-empty-logo" src={logo} alt="" /> : <div className="tv-empty-name">{name}</div>}
        <h1>{paused ? "The photo wall is taking a break" : "Be the first on the wall!"}</h1>
        {!paused && <p>Scan the code with your phone camera and send us a photo. Staff check every photo before it shows.</p>}
      </div>
      {!paused && (
        <div className="tv-empty-qr">
          <Qr url={address.url} className="tv-qr-code" />
          <JoinAddress url={address.short} label="Or go to" minScale={0.8} lines={2} />
        </div>
      )}
    </div>
  );
}

export function TvPage() {
  const wall = useWall({ intervalMs: 5000, reloadOnNewBuild: true });
  const venue = useVenue();
  useTvChrome();
  const layers = useSlideshow(wall);
  const now = useNow(5000);
  const onBox = isOnBox(venue);
  const address = sendAddress(venue);
  const name = wall?.name ?? (onBox ? venue.game.displayName : "Photo Wall");
  const logo = onBox ? venue.game.theme.logoDarkUrl || venue.game.theme.logoUrl : undefined;
  // The staff's announcement, drawn as a TV-sized strip (SDK 0.11.0: "show" can keep it to
  // phones; "position" puts it at the top or the bottom).
  const active = onBox ? activeAnnouncement(venue, now) : undefined;
  const announcement = active && active.show !== "phones" ? active : undefined;
  const announceAt = announcement?.position === "bottom" ? "bottom" : "top";
  const top = layers[layers.length - 1];
  const showingPhoto = !!top?.photo;

  return (
    <div className={`tv-page${announcement ? ` has-announce-${announceAt}` : ""}`}>
      {layers.map((l) => (
        <div key={l.key} className={`tv-layer${l.fade ? " tv-fade-in" : ""}`}>
          {l.photo ? <PhotoSlide photo={l.photo} /> : <BeTheFirst name={name} address={address} paused={!!wall?.paused} logo={logo} />}
        </div>
      ))}
      {announcement && (
        <div className={`tv-announce tv-announce-${announceAt}`} role="status">
          {announcement.text}
        </div>
      )}
      {showingPhoto && !wall?.paused && (
        <div className="tv-corner">
          <Qr url={address.url} className="tv-qr-code" />
          <div className="tv-corner-text">
            <strong>Send your photo</strong>
            <JoinAddress url={address.short} label="" minScale={0.7} lines={2} align="start" />
          </div>
        </div>
      )}
    </div>
  );
}
