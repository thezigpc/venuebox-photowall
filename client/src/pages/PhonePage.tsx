// /: a patron sends a photo to the TVs. Pick or take one, add a caption and a first name if
// they like, send. Staff check it before it shows; the page says so, and keeps a small "Your
// photos" list so they can see when theirs is up.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { BackToGames, VenueAnnouncement } from "@bargames/gamekit/client";
import { isOnBox } from "@bargames/sdk/client";
import { cleanCaption, cleanName, DEFAULT_NAME, MAX_CAPTION, MAX_NAME, MAX_UPLOAD_MB, type MyPhotoStatus, type PublicConfig } from "@photowall/shared";
import { api } from "../api";
import { preparePhoto, rememberSent, saveName, savedName, sendPhoto, sentPhotos, type SentPhoto } from "../upload";
import { useVenue } from "../useVenue";

type Step =
  | { kind: "pick" }
  | { kind: "compose"; file: File; url: string }
  | { kind: "sending"; url: string; progress: number }
  | { kind: "sent"; message: string };

const STATUS_TEXT: Record<MyPhotoStatus, string> = {
  pending: "Waiting for staff",
  approved: "On the wall",
  gone: "Not on the wall",
};

function useConfig(): PublicConfig | null {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.config().then((c) => live && setConfig(c), () => undefined);
    void load();
    // Staff may pause uploads during the night: notice without a reload.
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return config;
}

function YourPhotos({ sent }: { sent: SentPhoto[] }) {
  const [statuses, setStatuses] = useState<Record<string, MyPhotoStatus>>({});
  const ids = sent.map((s) => s.id).join(",");
  useEffect(() => {
    if (!ids) return;
    let live = true;
    const fetchNow = () => api.mine(ids.split(",")).then((r) => live && setStatuses(r.statuses), () => undefined);
    // Later checks only while the page is in front (a phone in a pocket doesn't poll).
    const load = () => {
      if (document.visibilityState === "visible") void fetchNow();
    };
    void fetchNow();
    const t = setInterval(load, 15_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [ids]);
  if (sent.length === 0) return null;
  return (
    <section className="card mine" aria-label="Your photos">
      <h2>Your photos</h2>
      <ul>
        {sent.map((s) => {
          const st = statuses[s.id];
          return (
            <li key={s.id}>
              {s.thumb ? <img src={s.thumb} alt="" /> : <span className="mine-blank" />}
              <span className={`mine-status${st ? ` is-${st}` : ""}`}>{st ? STATUS_TEXT[st] : "Checking…"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PhonePage() {
  const venue = useVenue();
  const config = useConfig();
  const onBox = isOnBox(venue);
  const name = config?.gameName || (onBox ? venue.game.displayName : DEFAULT_NAME);
  const logo = onBox ? venue.game.theme.logoUrl : undefined;
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [caption, setCaption] = useState("");
  const [first, setFirst] = useState(savedName);
  const [error, setError] = useState<{ text: string; field?: "caption" | "name" } | null>(null);
  const [sent, setSent] = useState<SentPhoto[]>(sentPhotos);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = name;
  }, [name]);

  // Object URLs for the preview are freed when the step changes.
  const url = step.kind === "compose" || step.kind === "sending" ? step.url : "";
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const picked = useCallback((input: HTMLInputElement | null) => {
    const file = input?.files?.[0];
    if (input) input.value = "";
    if (!file) return;
    setError(null);
    if (file.type && !file.type.startsWith("image/")) return setError({ text: "That isn't a photo. Pick a photo from your camera roll." });
    setStep({ kind: "compose", file, url: URL.createObjectURL(file) });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== "compose") return;
    setError(null);
    // The same checks as the server, so a patron hears about a caption before uploading.
    const c = cleanCaption(caption);
    if (!c.ok) return setError({ text: c.error, field: "caption" });
    const n = cleanName(first);
    if (!n.ok) return setError({ text: n.error, field: "name" });
    const { file, url: previewUrl } = step;
    setStep({ kind: "sending", url: previewUrl, progress: 0 });
    // Keep the object URL alive across the step change (it's revoked once we're done).
    const { blob, preview } = await preparePhoto(file);
    if (blob.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setStep({ kind: "compose", file, url: URL.createObjectURL(file) });
      return setError({ text: `That photo is over ${MAX_UPLOAD_MB} MB. Try a different one.` });
    }
    const r = await sendPhoto(blob, c.value, n.value, (progress) => setStep((s) => (s.kind === "sending" ? { ...s, progress } : s)));
    if (!r.ok) {
      setStep({ kind: "compose", file, url: URL.createObjectURL(file) });
      return setError({ text: r.error, field: r.field });
    }
    saveName(n.value);
    rememberSent({ id: r.id, at: Date.now(), thumb: preview });
    setSent(sentPhotos());
    setCaption("");
    setStep({ kind: "sent", message: r.message || "Sent! Staff will check it before it shows." });
  };

  const paused = config?.paused ?? false;
  const where = onBox ? "this venue's box" : "this server";

  return (
    <div className="page phone">
      <VenueAnnouncement ctx={venue} />
      <header className="ph-header">
        {logo && <img className="ph-logo" src={logo} alt="" />}
        <h1>{name}</h1>
        <p className="muted">Send a photo to the TVs.</p>
      </header>

      <main className="ph-main">
        {paused && step.kind !== "sent" && (
          <div className="card notice" role="status">
            <strong>Photo uploads are paused right now.</strong>
            <span className="muted"> Try again a bit later.</span>
          </div>
        )}

        {step.kind === "pick" && (
          <section className="card pick">
            <button className="primary big" disabled={paused} onClick={() => camera.current?.click()}>
              Take a photo
            </button>
            <button className="big" disabled={paused} onClick={() => library.current?.click()}>
              Choose a photo
            </button>
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => picked(e.currentTarget)} />
            <input ref={library} type="file" accept="image/*" hidden onChange={(e) => picked(e.currentTarget)} />
            {error && <p className="error">{error.text}</p>}
          </section>
        )}

        {(step.kind === "compose" || step.kind === "sending") && (
          <form className="card compose" onSubmit={submit}>
            <img className="preview" src={step.url} alt="Your photo" />
            <label>
              <span>
                Caption <span className="muted">(optional)</span>
              </span>
              <input
                value={caption}
                maxLength={MAX_CAPTION + 10}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Happy birthday, Jo!"
                disabled={step.kind === "sending"}
                aria-invalid={error?.field === "caption"}
                enterKeyHint="next"
              />
              <span className={`count${[...caption].length > MAX_CAPTION ? " error" : ""}`}>
                {[...caption].length}/{config?.maxCaption ?? MAX_CAPTION}
              </span>
            </label>
            <label>
              <span>
                Your first name <span className="muted">(optional)</span>
              </span>
              <input
                value={first}
                maxLength={MAX_NAME + 10}
                onChange={(e) => setFirst(e.target.value)}
                autoComplete="given-name"
                disabled={step.kind === "sending"}
                aria-invalid={error?.field === "name"}
                enterKeyHint="send"
              />
            </label>
            {error && <p className="error">{error.text}</p>}
            {step.kind === "sending" ? (
              <div className="progress" role="progressbar" aria-valuenow={Math.round(step.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${Math.max(4, step.progress * 100)}%` }} />
                <span>{step.progress >= 1 ? "Almost there…" : "Sending…"}</span>
              </div>
            ) : (
              <div className="row">
                <button type="button" onClick={() => setStep({ kind: "pick" })}>
                  Back
                </button>
                <button className="primary grow" disabled={paused}>
                  Send to the TVs
                </button>
              </div>
            )}
          </form>
        )}

        {step.kind === "sent" && (
          <section className="card sent" role="status">
            <div className="sent-mark" aria-hidden="true">
              ✓
            </div>
            <p className="sent-text">{step.message}</p>
            <button className="primary" onClick={() => setStep({ kind: "pick" })} disabled={paused}>
              Send another
            </button>
          </section>
        )}

        <YourPhotos sent={sent} />

        <p className="fine muted">
          Staff check every photo before it goes up on the TVs. Please only send photos of people who are happy to be on them.
          {config && ` Up to ${config.uploadsPerHour} photo${config.uploadsPerHour === 1 ? "" : "s"} an hour.`} Photos are deleted after{" "}
          {config?.retentionDays ?? 7} day{(config?.retentionDays ?? 7) === 1 ? "" : "s"} and stay on {where} only. The location and camera details
          in your photo are removed when it arrives.
        </p>
      </main>

      <footer className="ph-footer">
        <BackToGames ctx={venue} />
      </footer>
    </div>
  );
}
