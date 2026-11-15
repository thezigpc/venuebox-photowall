// The photos and settings, kept in memory and saved to DATA_DIR as JSON (the kit's atomic
// store). Files live in DATA_DIR/photos/, named by a random id. Nothing is public until staff
// approve it: the public routes look a photo up here and check its status every time.
//
// Photos leave the box three ways: staff reject or remove them, "clear the wall", or they
// get too old (the retention setting) or the storage cap is reached (oldest first).

import { randomBytes } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createJsonStore, log, type JsonStore } from "@bargames/gamekit/server";
import { DEFAULT_SETTINGS, mergeSettings, settingsFromStored, type Photo, type Settings, type StorageInfo } from "@photowall/shared";
import type { ProcessedPhoto } from "./images.js";

const PHOTOS_FILE = "photos.json";
const SETTINGS_FILE = "settings.json";
/** Photos kept at most, whatever their size. */
export const MAX_PHOTOS = 2000;
/** Waiting photos at most: past this the phone page says to try later (a flood can't fill the disk). */
export const MAX_PENDING = 300;
const DAY = 24 * 60 * 60 * 1000;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

const ID = /^[a-z0-9]{20}$/;

function photosFromStored(raw: unknown): Photo[] {
  const list = raw && typeof raw === "object" ? (raw as { photos?: unknown }).photos : null;
  if (!Array.isArray(list)) return [];
  const out: Photo[] = [];
  for (const p of list as Partial<Photo>[]) {
    if (!p || typeof p.id !== "string" || !ID.test(p.id)) continue;
    if (p.status !== "pending" && p.status !== "approved") continue;
    out.push({
      id: p.id,
      file: `${p.id}.jpg`,
      thumb: `${p.id}_t.jpg`,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      bytes: Number(p.bytes) || 0,
      caption: typeof p.caption === "string" ? p.caption : "",
      name: typeof p.name === "string" ? p.name : "",
      status: p.status,
      pinned: p.status === "approved" && !!p.pinned,
      createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
      approvedAt: p.status === "approved" && typeof p.approvedAt === "string" ? p.approvedAt : null,
      device: typeof p.device === "string" ? p.device : "",
    });
  }
  return out;
}

export interface NewPhoto {
  image: ProcessedPhoto;
  caption: string;
  name: string;
  device: string;
}

export class PhotoStore {
  readonly photosDir: string;
  private readonly json: JsonStore;
  private photos: Photo[] = [];
  private settings: Settings = { ...DEFAULT_SETTINGS };
  /** Bumped on every change: the wall's and the queue's version. */
  revision = 0;
  /** Called after every change (the box's attention item, for one). */
  onChange: () => void = () => undefined;

  constructor(
    readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.json = createJsonStore(dataDir);
    this.photosDir = path.join(dataDir, "photos");
  }

  async init(): Promise<void> {
    await mkdir(this.photosDir, { recursive: true });
    this.settings = settingsFromStored(await this.json.read(SETTINGS_FILE));
    const stored = photosFromStored(await this.json.read(PHOTOS_FILE));
    // Files and records must agree: a record without its file is dropped, and a file without a
    // record (a crash between writing it and saving photos.json) is deleted.
    const files = new Set(await readdir(this.photosDir));
    this.photos = stored.filter((p) => files.has(p.file) && files.has(p.thumb));
    const known = new Set(this.photos.flatMap((p) => [p.file, p.thumb]));
    for (const f of files) if (!known.has(f)) await unlink(path.join(this.photosDir, f)).catch(() => undefined);
    if (this.photos.length !== stored.length) await this.save();
    await this.sweep();
  }

  getSettings(): Settings {
    return this.settings;
  }

  async updateSettings(patch: unknown): Promise<Result<Settings>> {
    const r = mergeSettings(this.settings, patch);
    if (!r.ok) return { ok: false, error: r.error, status: 400 };
    const retentionShorter = r.value.retentionDays < this.settings.retentionDays;
    const capSmaller = r.value.storageMb < this.settings.storageMb;
    this.settings = r.value;
    await this.json.write(SETTINGS_FILE, this.settings);
    this.changed();
    if (retentionShorter || capSmaller) await this.sweep();
    return { ok: true, value: this.settings };
  }

  all(): readonly Photo[] {
    return this.photos;
  }

  get(id: string): Photo | undefined {
    return this.photos.find((p) => p.id === id);
  }

  /** Approved photos, oldest approval first. */
  approved(): Photo[] {
    return this.photos.filter((p) => p.status === "approved").sort((a, b) => (a.approvedAt ?? "").localeCompare(b.approvedAt ?? ""));
  }

  pending(): Photo[] {
    return this.photos.filter((p) => p.status === "pending").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  storage(): StorageInfo {
    return {
      usedBytes: this.photos.reduce((n, p) => n + p.bytes, 0),
      capBytes: this.settings.storageMb * 1024 * 1024,
      photos: this.photos.length,
      maxPhotos: MAX_PHOTOS,
    };
  }

  queueFull(): boolean {
    return this.pending().length >= MAX_PENDING;
  }

  async add(n: NewPhoto): Promise<Photo> {
    const id = randomBytes(10).toString("hex");
    const photo: Photo = {
      id,
      file: `${id}.jpg`,
      thumb: `${id}_t.jpg`,
      width: n.image.width,
      height: n.image.height,
      bytes: n.image.data.length + n.image.thumb.length,
      caption: n.caption,
      name: n.name,
      status: "pending",
      pinned: false,
      createdAt: new Date(this.now()).toISOString(),
      approvedAt: null,
      device: n.device,
    };
    await writeFile(path.join(this.photosDir, photo.file), n.image.data);
    await writeFile(path.join(this.photosDir, photo.thumb), n.image.thumb);
    this.photos.push(photo);
    await this.enforceCap(photo.id);
    await this.save();
    this.changed();
    return photo;
  }

  async approve(id: string, pin = false): Promise<Result<Photo>> {
    const p = this.get(id);
    if (!p) return { ok: false, error: "That photo is gone (another staff member may have handled it).", status: 404 };
    if (p.status === "approved") return { ok: false, error: "That photo is already on the wall.", status: 409 };
    p.status = "approved";
    p.pinned = pin;
    p.approvedAt = new Date(this.now()).toISOString();
    await this.save();
    this.changed();
    return { ok: true, value: p };
  }

  async setPinned(id: string, pinned: boolean): Promise<Result<Photo>> {
    const p = this.get(id);
    if (!p) return { ok: false, error: "That photo is gone.", status: 404 };
    if (p.status !== "approved") return { ok: false, error: "Approve the photo before pinning it.", status: 409 };
    p.pinned = pinned;
    await this.save();
    this.changed();
    return { ok: true, value: p };
  }

  /** Reject (pending) or remove (approved): either way the photo is deleted from the box. */
  async remove(id: string): Promise<Result<null>> {
    const p = this.get(id);
    if (!p) return { ok: false, error: "That photo is gone (another staff member may have handled it).", status: 404 };
    await this.drop([p]);
    await this.save();
    this.changed();
    return { ok: true, value: null };
  }

  /** End of the night: every photo, waiting or approved, deleted. */
  async clear(): Promise<number> {
    const n = this.photos.length;
    await this.drop([...this.photos]);
    // Anything else in the folder too (nothing should be there).
    for (const f of await readdir(this.photosDir).catch(() => [] as string[])) await unlink(path.join(this.photosDir, f)).catch(() => undefined);
    await this.save();
    this.changed();
    return n;
  }

  /** Deletes photos past the retention period, then trims to the storage cap. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.settings.retentionDays * DAY;
    const old = this.photos.filter((p) => Date.parse(p.createdAt) < cutoff);
    if (old.length) await this.drop(old);
    const trimmed = await this.enforceCap();
    if (old.length || trimmed) {
      log.info("photos", "removed old photos", { expired: old.length, overCap: trimmed });
      await this.save();
      this.changed();
    }
    return old.length + trimmed;
  }

  /** Oldest first (pinned photos last) until under the cap. `keep` is the photo just added. */
  private async enforceCap(keep?: string): Promise<number> {
    const cap = this.settings.storageMb * 1024 * 1024;
    let used = this.photos.reduce((n, p) => n + p.bytes, 0);
    let count = this.photos.length;
    if (used <= cap && count <= MAX_PHOTOS) return 0;
    const order = this.photos
      .filter((p) => p.id !== keep)
      .sort((a, b) => Number(a.pinned) - Number(b.pinned) || a.createdAt.localeCompare(b.createdAt));
    const gone: Photo[] = [];
    for (const p of order) {
      if (used <= cap && count <= MAX_PHOTOS) break;
      gone.push(p);
      used -= p.bytes;
      count--;
    }
    await this.drop(gone);
    return gone.length;
  }

  private async drop(list: Photo[]): Promise<void> {
    const ids = new Set(list.map((p) => p.id));
    this.photos = this.photos.filter((p) => !ids.has(p.id));
    for (const p of list) {
      await unlink(path.join(this.photosDir, p.file)).catch(() => undefined);
      await unlink(path.join(this.photosDir, p.thumb)).catch(() => undefined);
    }
  }

  private async save(): Promise<void> {
    await this.json.write(PHOTOS_FILE, { photos: this.photos });
  }

  private changed(): void {
    this.revision++;
    try {
      this.onChange();
    } catch (err) {
      log.warn("photos", "change listener failed", { err: String(err) });
    }
  }
}
