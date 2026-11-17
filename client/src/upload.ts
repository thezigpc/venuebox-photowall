// The patron's side of an upload: shrink the photo on the phone first (a 12 MB camera photo
// becomes ~1 MB, so it arrives quickly on busy venue Wi-Fi), then send it with progress.
// The server re-encodes and checks everything again; this is only to save time and data.

import { bgUrl } from "@bargames/sdk/client";

const DEVICE_KEY = "photowall.device";
const SENT_KEY = "photowall.sent";
const NAME_KEY = "photowall.name";
/** Bigger than the server keeps (1920), so the server's resize still has something to work with. */
const PHONE_MAX_PX = 2560;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * On a shared screen (a kiosk) each person gets their own id, kept in memory only, so one
 * person's photos don't use up the next person's hourly limit. The server's per-address cap
 * still holds for the kiosk as a whole.
 */
let personDevice = "";
export function newPerson(): void {
  personDevice = "";
}

/** This phone's random id, for the per-phone limit. Not tied to anything about the person. */
export function deviceId(shared = false): string {
  if (shared) return (personDevice ||= randomId());
  const s = storage();
  let id = s?.getItem(DEVICE_KEY) ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = randomId();
    try {
      s?.setItem(DEVICE_KEY, id);
    } catch {
      /* private mode: a fresh id per visit, the address limit still applies */
    }
  }
  return id;
}

export const savedName = () => storage()?.getItem(NAME_KEY) ?? "";
export function saveName(name: string) {
  try {
    if (name) storage()?.setItem(NAME_KEY, name);
    else storage()?.removeItem(NAME_KEY);
  } catch {
    /* fine */
  }
}

export interface SentPhoto {
  id: string;
  at: number;
  /** A small preview kept on this phone only, so the patron recognises it in "Your photos". */
  thumb: string;
}

const DAY = 24 * 60 * 60 * 1000;

export function sentPhotos(): SentPhoto[] {
  try {
    const list = JSON.parse(storage()?.getItem(SENT_KEY) ?? "[]") as SentPhoto[];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && Date.now() - p.at < DAY) : [];
  } catch {
    return [];
  }
}

export function rememberSent(p: SentPhoto): void {
  const list = [p, ...sentPhotos()].slice(0, 12);
  try {
    storage()?.setItem(SENT_KEY, JSON.stringify(list));
  } catch {
    // Too big with the thumbnails: keep the ids at least.
    try {
      storage()?.setItem(SENT_KEY, JSON.stringify(list.map((x) => ({ ...x, thumb: "" }))));
    } catch {
      /* fine */
    }
  }
}

async function canvasJpeg(source: CanvasImageSource, w: number, h: number, maxPx: number, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));
}

/**
 * The photo to send, shrunk on the phone when the browser can read it (upright: browsers apply
 * the EXIF orientation when drawing). Otherwise (say HEIC on a browser that can't decode it) the
 * original file goes and the server does the work.
 */
export async function preparePhoto(file: File): Promise<{ blob: Blob; preview: string }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const blob = await canvasJpeg(bitmap, bitmap.width, bitmap.height, PHONE_MAX_PX, 0.88);
      const thumb = await canvasJpeg(bitmap, bitmap.width, bitmap.height, 160, 0.7);
      if (blob) return { blob, preview: thumb ? await blobToDataUrl(thumb) : "" };
    } finally {
      bitmap.close();
    }
  } catch {
    /* fall through to the original */
  }
  return { blob: file, preview: "" };
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => resolve("");
    r.readAsDataURL(b);
  });
}

export type UploadResult = { ok: true; id: string; message: string } | { ok: false; error: string; field?: "caption" | "name"; code?: string };

export function sendPhoto(blob: Blob, caption: string, name: string, shared: boolean, onProgress: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", bgUrl("/api/photos"));
    xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
    xhr.setRequestHeader("x-photowall-device", deviceId(shared));
    if (caption) xhr.setRequestHeader("x-photowall-caption", encodeURIComponent(caption));
    if (name) xhr.setRequestHeader("x-photowall-name", encodeURIComponent(name));
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && body?.ok && typeof body.id === "string") return resolve({ ok: true, id: body.id, message: String(body.message ?? "") });
      resolve({
        ok: false,
        error: typeof body?.error === "string" ? body.error : xhr.status === 413 ? "That photo is too big." : `Something went wrong (${xhr.status}). Try again.`,
        field: body?.field === "caption" || body?.field === "name" ? body.field : undefined,
        code: typeof body?.code === "string" ? body.code : undefined,
      });
    };
    const offline = () => resolve({ ok: false, error: "The photo didn't get through. Check you're on the Wi-Fi and try again." });
    xhr.onerror = offline;
    xhr.ontimeout = offline;
    xhr.send(blob);
  });
}
