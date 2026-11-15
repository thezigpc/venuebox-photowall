// The HTTP app. Built by a function so tests can run it in-process with their own data dir.
//
// Public:  the phone's upload, the TV's wall (approved photos only), a patron's own statuses.
// Staff:   /api/admin/* behind the kit's admin sign-in (box staff sign-in, the box's
//          password, or the app's own password standalone): the queue, decisions, settings.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import type { BarGames } from "@bargames/sdk/server";
import { adminRouter, createAdminAuth, createJsonStore, log, serveSpa, type AdminAuth } from "@bargames/gamekit/server";
import {
  cleanCaption,
  cleanName,
  DEFAULT_NAME,
  MAX_CAPTION,
  MAX_NAME,
  MAX_UPLOAD_MB,
  type AdminState,
  type Moderation,
  type MyPhotoStatus,
  type Photo,
  type PublicConfig,
  type StaffPhoto,
  type Wall,
} from "@photowall/shared";
import { APPROVED_EVENT, attentionReporter, venueName } from "./bargames.js";
import { processPhoto, UploadError } from "./images.js";
import { PhotoStore } from "./photoStore.js";
import { HourlyLimiter } from "./rateLimit.js";

export interface AppOptions {
  dataDir: string;
  bg: BarGames;
  adminPassword?: string;
  /** GAME_NAME env (standalone default name). */
  gameName?: string;
  clientDist?: string;
  /** Path prefix the page runs under (SDK 0.10.0), e.g. "/photowall". Default: bg.basePath. */
  basePath?: string;
  /** Clock, for tests. */
  now?: () => number;
  /** How often old photos are swept out (default 10 minutes). */
  sweepMs?: number;
  /** Delay before the box's attention item is updated (tests use 0). */
  attentionDelayMs?: number;
}

export interface WallApp {
  app: express.Express;
  store: PhotoStore;
  auth: AdminAuth;
  limiter: HourlyLimiter;
  close(): void;
}

export const SENT_MESSAGE = "Sent! Staff will check it before it shows.";

/** Async route errors go to Express instead of becoming unhandled rejections. */
const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: (err?: unknown) => void) =>
    void fn(req, res).catch(next);

const PHOTO_ID = /^[a-f0-9]{20}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

function header(req: Request, name: string): string | undefined {
  const raw = req.get(name);
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m === 1 ? "a minute" : `${m} minutes`;
}

export async function createApp(o: AppOptions): Promise<WallApp> {
  const bg = o.bg;
  const now = o.now ?? Date.now;
  const store = new PhotoStore(o.dataDir, now);
  await store.init();
  const limiter = new HourlyLimiter(now);

  const auth = createAdminAuth({
    store: createJsonStore(o.dataDir),
    envPassword: o.adminPassword ?? "",
    saltFormat: "bytes",
    // Standalone behind Cloudflare a whole venue shares one public IP, so a per-IP lockout
    // would let any guest lock the staff out; on a box each device has its own address.
    failsAllowed: bg.connected ? undefined : Number.POSITIVE_INFINITY,
    venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip),
    onBox: bg.connected,
  });
  await auth.init();

  const report = attentionReporter(bg, o.attentionDelayMs);
  store.onChange = () => report(store.pending().length, store.getSettings().paused);
  store.onChange();

  const sweeper = setInterval(() => {
    limiter.prune();
    void store.sweep().catch((err: unknown) => log.error("photos", "sweep failed", { err: String(err) }));
  }, o.sweepMs ?? 10 * 60_000);
  sweeper.unref();

  // The client build being served: a TV left on for days reloads when it changes.
  const indexHtml = o.clientDist ? path.join(o.clientDist, "index.html") : "";
  const hasClient = !!indexHtml && existsSync(indexHtml);
  const build = hasClient ? createHash("sha1").update(readFileSync(indexHtml)).digest("hex").slice(0, 12) : "dev";

  const displayName = async () => (await venueName(bg)) ?? (store.getSettings().name || o.gameName || DEFAULT_NAME);

  const staffPhoto = (p: Photo): StaffPhoto => ({
    id: p.id,
    imageUrl: `/api/admin/photos/${p.id}/image`,
    thumbUrl: `/api/admin/photos/${p.id}/thumb`,
    width: p.width,
    height: p.height,
    caption: p.caption,
    name: p.name,
    status: p.status,
    pinned: p.pinned,
    createdAt: p.createdAt,
    approvedAt: p.approvedAt,
  });

  async function wall(): Promise<Wall> {
    const s = store.getSettings();
    const body = {
      build,
      name: await displayName(),
      paused: s.paused,
      slideSeconds: s.slideSeconds,
      pinnedWeight: s.pinnedWeight,
      showCaptions: s.showCaptions,
      showNames: s.showNames,
      // Only what the settings allow leaves the server: a hidden name isn't sent at all.
      photos: store.approved().map((p) => ({
        id: p.id,
        url: `/photos/${p.file}`,
        width: p.width,
        height: p.height,
        caption: s.showCaptions ? p.caption : "",
        name: s.showNames ? p.name : "",
        pinned: p.pinned,
        approvedAt: p.approvedAt ?? p.createdAt,
      })),
    };
    const version = createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16);
    return { ...body, version, serverTime: now() };
  }

  function moderation(): Moderation {
    return {
      version: `${store.revision}`,
      paused: store.getSettings().paused,
      pending: store.pending().map(staffPhoto),
      approved: store.approved().reverse().map(staffPhoto),
      storage: store.storage(),
    };
  }

  /** 200 with an ETag, or 304 when the client already has this version. */
  function sendVersioned(req: Request, res: Response, version: string, body: unknown) {
    const etag = `W/"${version}"`;
    res.set("Cache-Control", "no-cache");
    res.set("ETag", etag);
    if (req.get("if-none-match") === etag) return void res.status(304).end();
    res.json(body);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  // Bar Games: /__bargames/* (venue.json, theme.css, status). Before the SPA catch-all.
  app.use(bg.middleware());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, photos: store.all().length });
  });

  app.get(
    "/api/config",
    safe(async (_req, res) => {
      const s = store.getSettings();
      const body: PublicConfig & { gameName: string } = {
        gameName: await displayName(),
        paused: s.paused,
        uploadsPerHour: s.uploadsPerHour,
        retentionDays: s.retentionDays,
        maxCaption: MAX_CAPTION,
        maxName: MAX_NAME,
        maxUploadMb: MAX_UPLOAD_MB,
      };
      res.set("Cache-Control", "no-cache");
      res.json(body);
    }),
  );

  // The TVs poll this every few seconds; an unchanged wall costs a 304.
  app.get(
    "/api/wall",
    safe(async (req, res) => {
      const w = await wall();
      sendVersioned(req, res, w.version, w);
    }),
  );

  // Approved photos only. The status is checked on every request, so a photo staff remove is
  // gone at once. Kept out of shared caches (a proxy would keep serving a removed photo).
  app.get("/photos/:file", (req, res) => {
    const m = /^([a-f0-9]{20})\.jpg$/.exec(String(req.params.file));
    const p = m ? store.get(m[1]) : undefined;
    if (!p || p.status !== "approved") return void res.status(404).json({ ok: false, error: "Not found." });
    res.set("Cache-Control", "private, max-age=300");
    res.set("X-Content-Type-Options", "nosniff");
    res.sendFile(path.join(store.photosDir, p.file), { dotfiles: "deny" });
  });

  // A patron's own photos: the ids their uploads returned (random, so nobody can guess others').
  app.get("/api/mine", (req, res) => {
    const ids = String(req.query.ids ?? "")
      .split(",")
      .filter((id) => PHOTO_ID.test(id))
      .slice(0, 30);
    const statuses: Record<string, MyPhotoStatus> = {};
    for (const id of ids) statuses[id] = store.get(id)?.status ?? "gone";
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, statuses });
  });

  const rawImage = express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` });
  app.post(
    "/api/photos",
    (req, res, next) => {
      // Refuse before reading a 15 MB body we'd throw away.
      if (store.getSettings().paused) return void res.status(423).json({ ok: false, code: "paused", error: "Photo uploads are paused right now. Try again later." });
      const declared = Number(req.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_MB * 1024 * 1024) {
        return void res.status(413).json({ ok: false, error: `That photo is over ${MAX_UPLOAD_MB} MB.` });
      }
      rawImage(req, res, (err?: unknown) => {
        if (!err) return next();
        const tooBig = (err as { type?: string }).type === "entity.too.large";
        res.status(tooBig ? 413 : 400).json({ ok: false, error: tooBig ? `That photo is over ${MAX_UPLOAD_MB} MB.` : "The photo didn't arrive in one piece. Try again." });
      });
    },
    safe(async (req, res) => {
      const s = store.getSettings();
      const caption = cleanCaption(header(req, "x-photowall-caption"));
      if (!caption.ok) return void res.status(400).json({ ok: false, field: "caption", error: caption.error });
      const name = cleanName(header(req, "x-photowall-name"));
      if (!name.ok) return void res.status(400).json({ ok: false, field: "name", error: name.error });

      const ip = bg.clientIp(req);
      const rawDevice = req.get("x-photowall-device") ?? "";
      const device = DEVICE_ID.test(rawDevice) ? hash(rawDevice) : `ip-${hash(ip)}`;
      const limited = () => {
        const c = limiter.check(device, ip, s.uploadsPerHour);
        if (c.allowed) return false;
        res.status(429).json({
          ok: false,
          code: "limit",
          error: `That's ${s.uploadsPerHour} photo${s.uploadsPerHour === 1 ? "" : "s"} from this phone in the last hour. You can send another in ${minutes(c.retryInMs)}.`,
        });
        return true;
      };
      if (limited()) return;
      if (store.queueFull()) return void res.status(503).json({ ok: false, code: "busy", error: "Staff have a lot of photos to look at. Try again in a few minutes." });

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ ok: false, error: "No photo in the upload." });
      let image;
      try {
        image = await processPhoto(body);
      } catch (err) {
        if (err instanceof UploadError) return void res.status(415).json({ ok: false, error: err.message });
        throw err;
      }
      // Checked again: the same phone may have had several uploads in flight.
      if (store.getSettings().paused) return void res.status(423).json({ ok: false, code: "paused", error: "Photo uploads are paused right now. Try again later." });
      if (limited()) return;
      limiter.record(device, ip);
      const photo = await store.add({ image, caption: caption.value, name: name.value, device });
      log.info("photos", "photo received", { id: photo.id, width: photo.width, height: photo.height, pending: store.pending().length });
      res.json({ ok: true, id: photo.id, message: SENT_MESSAGE });
    }),
  );

  // ----------------------------------------------------------------- staff
  // Staff signed in to the venue box's admin get a session without the password (SDK 0.7.0).
  const admin = adminRouter({ auth, clientIp: (req) => bg.clientIp(req), trusted: (req) => bg.isStaff(req) });

  admin.get("/moderation", (req, res) => {
    const m = moderation();
    sendVersioned(req, res, `${m.version}-${m.paused}`, m);
  });

  for (const kind of ["image", "thumb"] as const) {
    admin.get(`/photos/:id/${kind}`, (req, res) => {
      const p = store.get(String(req.params.id));
      if (!p) return void res.status(404).json({ ok: false, error: "That photo is gone." });
      res.set("Cache-Control", "private, max-age=3600");
      res.set("X-Content-Type-Options", "nosniff");
      res.sendFile(path.join(store.photosDir, kind === "image" ? p.file : p.thumb), { dotfiles: "deny" });
    });
  }

  admin.post(
    "/photos/:id/approve",
    safe(async (req, res) => {
      const pin = req.body?.pin === true;
      const r = await store.approve(String(req.params.id), pin);
      if (!r.ok) return void res.status(r.status ?? 400).json(r);
      log.info("photos", "approved", { id: r.value.id, pinned: pin });
      bg.emit({ type: APPROVED_EVENT, data: { photoId: r.value.id, pinned: pin, onWall: store.approved().length } });
      res.json({ ok: true, value: staffPhoto(r.value) });
    }),
  );

  admin.post(
    "/photos/:id/reject",
    safe(async (req, res) => {
      const p = store.get(String(req.params.id));
      if (p && p.status !== "pending") return void res.status(409).json({ ok: false, error: "That photo is already on the wall. Remove it instead." });
      const r = await store.remove(String(req.params.id));
      if (r.ok) log.info("photos", "rejected", { id: req.params.id });
      res.status(r.ok ? 200 : (r.status ?? 400)).json(r);
    }),
  );

  admin.post(
    "/photos/:id/pin",
    safe(async (req, res) => {
      if (typeof req.body?.pinned !== "boolean") return void res.status(400).json({ ok: false, error: "pinned must be true or false." });
      const r = await store.setPinned(String(req.params.id), req.body.pinned);
      res.status(r.ok ? 200 : (r.status ?? 400)).json(r.ok ? { ok: true, value: staffPhoto(r.value) } : r);
    }),
  );

  admin.delete(
    "/photos/:id",
    safe(async (req, res) => {
      const r = await store.remove(String(req.params.id));
      if (r.ok) log.info("photos", "removed", { id: req.params.id });
      res.status(r.ok ? 200 : (r.status ?? 400)).json(r);
    }),
  );

  admin.put(
    "/paused",
    safe(async (req, res) => {
      if (typeof req.body?.paused !== "boolean") return void res.status(400).json({ ok: false, error: "paused must be true or false." });
      const r = await store.updateSettings({ paused: req.body.paused });
      if (r.ok) log.info("photos", r.value.paused ? "uploads paused" : "uploads resumed");
      res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, paused: r.value.paused } : r);
    }),
  );

  admin.post(
    "/clear",
    safe(async (req, res) => {
      // A typed confirmation, so a stray request can't wipe the night's photos.
      if (req.body?.confirm !== "clear") return void res.status(400).json({ ok: false, error: 'Send { "confirm": "clear" } to clear the wall.' });
      const n = await store.clear();
      log.info("photos", "wall cleared", { removed: n });
      res.json({ ok: true, removed: n });
    }),
  );

  admin.get("/state", (_req, res) => {
    const body: AdminState = {
      settings: store.getSettings(),
      storage: store.storage(),
      counts: { pending: store.pending().length, approved: store.approved().length },
      onBox: bg.connected,
    };
    res.json(body);
  });

  admin.put(
    "/settings",
    safe(async (req, res) => {
      const r = await store.updateSettings(req.body);
      if (r.ok) log.info("admin", "settings saved");
      res.status(r.ok ? 200 : 400).json(r);
    }),
  );

  app.use("/api/admin", admin);
  app.use("/api", (_req, res) => void res.status(404).json({ ok: false, error: "Not found." }));

  // ----------------------------------------------------------------- client
  if (hasClient && o.clientDist) {
    serveSpa(app, { dist: o.clientDist, basePath: o.basePath ?? bg.basePath });
  } else {
    log.warn("boot", "client build not found; serving the API only", { path: o.clientDist });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: (e?: unknown) => void) => {
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("http", "request failed", { err: String(err) });
    if (!res.headersSent) res.status(status).json({ ok: false, error: status === 404 ? "Not found." : "Something went wrong." });
  });

  return {
    app,
    store,
    auth,
    limiter,
    close: () => {
      clearInterval(sweeper);
      auth.close();
    },
  };
}
