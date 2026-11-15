// /host: the staff's moderation queue. Waiting photos, oldest first, with Approve, Approve + pin
// and Reject; the photos on the wall with Pin/Unpin and Remove; "Pause new uploads" and
// "Clear the wall". Built for an iPad or a phone behind the bar: big buttons, no hover.

import { useCallback, useEffect, useRef, useState } from "react";
import { BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl, isOnBox } from "@bargames/sdk/client";
import type { Moderation, StaffPhoto } from "@photowall/shared";
import { api, ApiError, forgetStaffImages, getToken, staffImage } from "../api";
import { StaffGate, type Staff } from "../StaffGate";
import { useVenue } from "../useVenue";

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function StaffImg({ path, alt, className, onClick }: { path: string; alt: string; className?: string; onClick?: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    staffImage(path).then((u) => live && setSrc(u), () => undefined);
    return () => {
      live = false;
    };
  }, [path]);
  const img = src ? <img className={className} src={src} alt={alt} /> : <div className={`${className ?? ""} img-loading`} />;
  return onClick ? (
    <button type="button" className="img-button" onClick={onClick} aria-label="View full size">
      {img}
    </button>
  ) : (
    img
  );
}

function useModeration(staff: Staff) {
  const [data, setData] = useState<Moderation | null>(null);
  const [offline, setOffline] = useState(false);
  const etag = useRef("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(bgUrl("/api/admin/moderation"), {
        cache: "no-store",
        headers: { authorization: `Bearer ${getToken()}`, ...(etag.current ? { "if-none-match": etag.current } : {}) },
      });
      if (res.status === 401) return staff.expired();
      setOffline(false);
      if (res.status === 304) return;
      if (!res.ok) return;
      etag.current = res.headers.get("etag") ?? "";
      const m = (await res.json()) as Moderation;
      setData(m);
      forgetStaffImages(new Set([...m.pending, ...m.approved].flatMap((p) => [p.thumbUrl, p.imageUrl])));
    } catch {
      setOffline(true);
    }
  }, [staff]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  return { data, offline, reload: load };
}

function Queue({ staff }: { staff: Staff }) {
  const { data, offline, reload } = useModeration(staff);
  const [tab, setTab] = useState<"pending" | "approved">("pending");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [viewing, setViewing] = useState<StaffPhoto | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.title = data?.pending.length ? `(${data.pending.length}) Photo Wall queue` : "Photo Wall queue";
  }, [data?.pending.length]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const act = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy((b) => new Set(b).add(id));
    try {
      await fn();
      if (ok) setNotice({ text: ok, error: false });
      if (viewing?.id === id) setViewing(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return staff.expired();
      setNotice({ text: err instanceof Error ? err.message : "That didn't work.", error: true });
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
      await reload();
    }
  };

  if (!data) return <p className="muted center">{offline ? "Can't reach the server. Retrying…" : "Loading…"}</p>;

  const list = tab === "pending" ? data.pending : data.approved;
  const usedPct = data.storage.capBytes ? Math.round((data.storage.usedBytes / data.storage.capBytes) * 100) : 0;

  return (
    <>
      <header className="host-header">
        <h1>Photo Wall</h1>
        <nav>
          <a href={bgUrl("/tv")} target="_blank" rel="noreferrer">
            TV view
          </a>
          <a href={bgUrl("/admin")}>Settings</a>
          <button className="link" onClick={() => void staff.signOut()}>
            Sign out
          </button>
        </nav>
      </header>

      {offline && <div className="banner error">Can't reach the server. Retrying…</div>}

      <section className="card controls">
        <label className="switch">
          <input
            type="checkbox"
            checked={data.paused}
            onChange={(e) => {
              const paused = e.currentTarget.checked;
              void act("__paused", () => api.setPaused(paused), paused ? "New uploads paused." : "Uploads are open again.");
            }}
            disabled={busy.has("__paused")}
          />
          <span>
            <strong>Pause new uploads</strong>
            <span className="muted small">{data.paused ? "Phones can't send photos right now. The wall keeps playing." : "Phones can send photos."}</span>
          </span>
        </label>
        {!confirmClear ? (
          <button className="danger" onClick={() => setConfirmClear(true)}>
            Clear the wall
          </button>
        ) : (
          <div className="confirm">
            <span>
              Delete all {data.pending.length + data.approved.length} photos (waiting and on the wall)? This can't be undone.
            </span>
            <div className="row">
              <button onClick={() => setConfirmClear(false)}>Keep them</button>
              <button
                className="danger"
                onClick={() => {
                  setConfirmClear(false);
                  void act("__clear", () => api.clear(), "The wall is clear.");
                }}
              >
                Delete all
              </button>
            </div>
          </div>
        )}
      </section>

      {notice && (
        <div className={`notice-bar${notice.error ? " is-error" : ""}`} role="status">
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "is-on" : ""} onClick={() => setTab("pending")}>
          Waiting <span className="badge">{data.pending.length}</span>
        </button>
        <button role="tab" aria-selected={tab === "approved"} className={tab === "approved" ? "is-on" : ""} onClick={() => setTab("approved")}>
          On the wall <span className="badge">{data.approved.length}</span>
        </button>
      </div>

      {list.length === 0 && (
        <p className="muted center empty">{tab === "pending" ? "Nothing waiting. New photos show up here by themselves." : "No photos on the wall yet."}</p>
      )}

      <ul className="grid">
        {list.map((p) => {
          const b = busy.has(p.id);
          return (
            <li key={p.id} className={`card tile${p.pinned ? " is-pinned" : ""}`}>
              <StaffImg path={p.thumbUrl} alt={p.caption || "Patron photo"} className="thumb" onClick={() => setViewing(p)} />
              <div className="tile-text">
                {p.caption ? <p className="tile-caption">“{p.caption}”</p> : <p className="muted small">No caption</p>}
                <p className="muted small">
                  {p.name ? `${p.name} · ` : ""}
                  {ago(p.status === "approved" && p.approvedAt ? p.approvedAt : p.createdAt, now)}
                  {p.pinned ? " · Pinned" : ""}
                </p>
              </div>
              {p.status === "pending" ? (
                <div className="tile-actions">
                  <button className="primary" disabled={b} onClick={() => void act(p.id, () => api.approve(p.id), "On the wall.")}>
                    Approve
                  </button>
                  <button disabled={b} onClick={() => void act(p.id, () => api.approve(p.id, true), "On the wall, pinned.")}>
                    Approve + pin
                  </button>
                  <button className="danger" disabled={b} onClick={() => void act(p.id, () => api.reject(p.id), "Rejected and deleted.")}>
                    Reject
                  </button>
                </div>
              ) : (
                <div className="tile-actions">
                  <button disabled={b} onClick={() => void act(p.id, () => api.pin(p.id, !p.pinned), p.pinned ? "Unpinned." : "Pinned.")}>
                    {p.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button className="danger" disabled={b} onClick={() => void act(p.id, () => api.remove(p.id), "Removed and deleted.")}>
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="muted small center">
        Storage: {(data.storage.usedBytes / 1024 / 1024).toFixed(1)} MB of {Math.round(data.storage.capBytes / 1024 / 1024)} MB ({usedPct}%). When it's
        full, the oldest photos are deleted first.
      </p>

      {viewing && (
        <div className="viewer" role="dialog" aria-label="Photo" onClick={() => setViewing(null)}>
          <StaffImg path={viewing.imageUrl} alt={viewing.caption || "Patron photo"} className="viewer-img" />
          {(viewing.caption || viewing.name) && (
            <p className="viewer-text">
              {viewing.caption && `“${viewing.caption}”`} {viewing.name && `— ${viewing.name}`}
            </p>
          )}
          <p className="muted small">Tap anywhere to close</p>
        </div>
      )}
    </>
  );
}

export function HostPage() {
  const venue = useVenue();
  return (
    <div className="page host">
      <VenueAnnouncement ctx={venue} />
      {isOnBox(venue) && (
        <div className="box-admin">
          <BoxAdminLink ctx={venue} />
        </div>
      )}
      <StaffGate title="Photo Wall staff">{(staff) => <Queue staff={staff} />}</StaffGate>
    </div>
  );
}
