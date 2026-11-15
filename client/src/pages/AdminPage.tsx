// /admin: the photo wall's settings, and what happens to patrons' photos.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl, isOnBox } from "@bargames/sdk/client";
import { LIMITS, type AdminState, type Settings } from "@photowall/shared";
import { api, ApiError } from "../api";
import { StaffGate, type Staff } from "../StaffGate";
import { useVenue } from "../useVenue";

type NumberKey = keyof typeof LIMITS;

const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string }[] = [
  { key: "uploadsPerHour", label: "Photos per phone per hour", hint: "How many photos one phone can send in an hour." },
  { key: "retentionDays", label: "Delete photos after (days)", hint: "Every photo, waiting or on the wall, is deleted this long after it was sent." },
  { key: "slideSeconds", label: "Seconds per photo on the TV", hint: "" },
  { key: "pinnedWeight", label: "Pinned photos show … times as often", hint: "" },
  { key: "storageMb", label: "Storage for photos (MB)", hint: "When it's full, the oldest photos are deleted first." },
];

function SettingsForm({ staff }: { staff: Staff }) {
  const venue = useVenue();
  const onBox = isOnBox(venue);
  const [state, setState] = useState<AdminState | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setDraft(s.settings);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return staff.expired();
      setNotice({ text: err instanceof Error ? err.message : "Couldn't load.", error: true });
    }
  }, [staff]);

  useEffect(() => {
    document.title = "Photo Wall settings";
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    try {
      const { paused: _paused, ...patch } = draft; // the host page owns the pause switch
      await api.saveSettings(patch);
      setNotice({ text: "Saved. The TVs pick it up within a few seconds.", error: false });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return staff.expired();
      setNotice({ text: err instanceof Error ? err.message : "That didn't work.", error: true });
    } finally {
      setSaving(false);
    }
  };

  if (!state || !draft) return <p className="muted center">Loading…</p>;
  const where = state.onBox ? "this box" : "this server";
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1);

  return (
    <>
      <header className="host-header">
        <h1>Photo Wall settings</h1>
        <nav>
          <a href={bgUrl("/host")}>Moderation queue</a>
          <a href={bgUrl("/tv")} target="_blank" rel="noreferrer">
            TV view
          </a>
          <a href={bgUrl("/")} target="_blank" rel="noreferrer">
            Phone page
          </a>
          <button className="link" onClick={() => void staff.signOut()}>
            Sign out
          </button>
        </nav>
      </header>

      {notice && (
        <div className={`notice-bar${notice.error ? " is-error" : ""}`} role="status">
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <section className="card privacy">
        <h2>Patrons' photos</h2>
        <ul>
          <li>
            <strong>Patrons' photos stay on {where} only.</strong> They're never sent anywhere else{state.onBox ? " (on the box the photo wall has no internet access at all)" : ""}.
          </li>
          <li>Nothing shows on a TV until a staff member approves it on the moderation queue.</li>
          <li>Location, camera and other details are removed from every photo as it arrives.</li>
          <li>
            Every photo is deleted {draft.retentionDays} day{draft.retentionDays === 1 ? "" : "s"} after it was sent, when staff reject or remove it, and when
            staff clear the wall.
          </li>
        </ul>
        <p className="muted small">
          Now: {state.counts.pending} waiting, {state.counts.approved} on the wall, {mb(state.storage.usedBytes)} MB of {mb(state.storage.capBytes)} MB.
        </p>
      </section>

      <form className="card settings" onSubmit={save}>
        <h2>Settings</h2>
        {!onBox && (
          <label>
            Name
            <input value={draft.name} maxLength={60} placeholder="Photo Wall" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
        )}
        {NUMBER_FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              type="number"
              inputMode="numeric"
              min={LIMITS[f.key][0]}
              max={LIMITS[f.key][1]}
              step={1}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
              required
            />
            {f.hint && <span className="muted small">{f.hint}</span>}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={draft.showCaptions} onChange={(e) => setDraft({ ...draft, showCaptions: e.target.checked })} />
          Show captions on the TV
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.showNames} onChange={(e) => setDraft({ ...draft, showNames: e.target.checked })} />
          Show senders' first names on the TV
        </label>
        <button className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </>
  );
}

export function AdminPage() {
  const venue = useVenue();
  return (
    <div className="page host">
      <VenueAnnouncement ctx={venue} />
      {isOnBox(venue) && (
        <div className="box-admin">
          <BoxAdminLink ctx={venue} />
        </div>
      )}
      <StaffGate title="Photo Wall settings">{(staff) => <SettingsForm staff={staff} />}</StaffGate>
    </div>
  );
}
