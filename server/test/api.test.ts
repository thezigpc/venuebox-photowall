// The photo wall end to end, standalone: upload → moderation → the TV's wall, and every way a
// photo leaves the box.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { AdminState, Moderation, Wall } from "@photowall/shared";
import { SENT_MESSAGE } from "../src/app.js";
import { makePhoto, newDevice, startApp, type TestApp } from "./helpers.js";

const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

async function sendPhoto(t: TestApp, opts: Parameters<TestApp["upload"]>[1] = {}): Promise<string> {
  const r = await t.upload(await makePhoto(800, 600), opts);
  const body = await json<{ ok: boolean; id: string; error?: string }>(r);
  assert.equal(r.status, 200, body.error);
  return body.id;
}

describe("uploads", () => {
  let t: TestApp;
  before(async () => (t = await startApp()));
  after(() => t.stop());

  test("a photo arrives as pending, re-encoded, with the patron's message", async () => {
    const r = await t.upload(await makePhoto(4000, 3000, { gps: true }), { caption: " Happy  birthday Jo! ", name: "Sam Smith" });
    const body = await json<{ ok: boolean; id: string; message: string }>(r);
    assert.equal(r.status, 200);
    assert.equal(body.message, SENT_MESSAGE);
    assert.equal(body.message, "Sent! Staff will check it before it shows.");
    const p = t.wall.store.get(body.id)!;
    assert.equal(p.status, "pending");
    assert.equal(p.caption, "Happy birthday Jo!");
    assert.equal(p.name, "Sam");
    assert.equal(Math.max(p.width, p.height), 1920);
  });

  test("EXIF (location, device) is stripped, and the photo is upright", async () => {
    const id = await sendPhoto(t, {});
    const gps = await t.upload(await makePhoto(1200, 800, { gps: true }));
    const gid = (await json<{ id: string }>(gps)).id;
    // Orientation 6: stored 1200x800, shown as 800x1200.
    const rot = await t.upload(await makePhoto(1200, 800, { orientation: 6 }));
    const rid = (await json<{ id: string }>(rot)).id;
    for (const pid of [id, gid, rid]) {
      const file = path.join(t.wall.store.photosDir, t.wall.store.get(pid)!.file);
      const meta = await sharp(file).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.exif, undefined, "no EXIF");
      assert.equal(meta.xmp, undefined, "no XMP");
      assert.equal(meta.iptc, undefined, "no IPTC");
      assert.ok(!meta.orientation || meta.orientation === 1);
    }
    const r = t.wall.store.get(rid)!;
    assert.deepEqual([r.width, r.height], [800, 1200]);
  });

  test("PNG and WebP become JPEG", async () => {
    for (const format of ["png", "webp"] as const) {
      const r = await t.upload(await makePhoto(500, 500, { format }), { headers: { "content-type": `image/${format}` } });
      const id = (await json<{ id: string }>(r)).id;
      const meta = await sharp(path.join(t.wall.store.photosDir, t.wall.store.get(id)!.file)).metadata();
      assert.equal(meta.format, "jpeg");
    }
  });

  test("non-images, SVG, tiny images and empty uploads are refused", async () => {
    assert.equal((await t.upload(Buffer.from("hello, not a photo"))).status, 415);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500"/></svg>');
    assert.equal((await t.upload(svg)).status, 415);
    assert.equal((await t.upload(await makePhoto(20, 20))).status, 415);
    assert.equal((await t.upload(Buffer.alloc(0))).status, 400);
  });

  test("oversized uploads are refused", async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 1);
    const r = await t.upload(big);
    assert.equal(r.status, 413);
    assert.match((await json<{ error: string }>(r)).error, /15 MB/);
  });

  test("captions and names go through the filter", async () => {
    const bad = await t.upload(await makePhoto(300, 300), { caption: "this is shit" });
    assert.equal(bad.status, 400);
    assert.equal((await json<{ field: string }>(bad)).field, "caption");
    const link = await t.upload(await makePhoto(300, 300), { caption: "go to www.spam.com" });
    assert.equal(link.status, 400);
    const long = await t.upload(await makePhoto(300, 300), { caption: "x".repeat(81) });
    assert.equal(long.status, 400);
    const name = await t.upload(await makePhoto(300, 300), { name: "12345" });
    assert.equal((await json<{ field: string }>(name)).field, "name");
  });

  test("N photos per phone per hour", async () => {
    const device = newDevice();
    for (let i = 0; i < 5; i++) await sendPhoto(t, { device, headers: { "x-test": String(i) } });
    const r = await t.upload(await makePhoto(300, 300), { device });
    assert.equal(r.status, 429);
    assert.match((await json<{ error: string }>(r)).error, /5 photos from this phone in the last hour. You can send another in 60 minutes/);
    // Another phone is fine.
    await sendPhoto(t);
    // An hour later the first phone may send again.
    t.clock.now += 60 * 60 * 1000 + 1;
    await sendPhoto(t, { device });
  });

  test("a refused upload doesn't count toward the limit", async () => {
    const device = newDevice();
    for (let i = 0; i < 6; i++) await t.upload(Buffer.from("nope"), { device });
    await sendPhoto(t, { device });
  });

  test("one address can't get round the limit with new device ids", async () => {
    t.wall.limiter.clear();
    // 5 per hour x 4 phones' worth = 20 from one address.
    for (let i = 0; i < 20; i++) await sendPhoto(t);
    assert.equal((await t.upload(await makePhoto(300, 300))).status, 429);
    t.wall.limiter.clear();
  });
});

describe("moderation", () => {
  let t: TestApp;
  let token: string;
  before(async () => {
    t = await startApp();
    token = await t.login();
  });
  after(() => t.stop());
  beforeEach(async () => {
    await t.send("POST", "/api/admin/clear", { confirm: "clear" }, token);
    t.wall.limiter.clear();
  });

  const wall = () => json<Wall>(t.get("/api/wall"));
  const queue = () => json<Moderation>(t.get("/api/admin/moderation", token));

  test("nothing reaches the TV until staff approve it", async () => {
    const id = await sendPhoto(t, { caption: "Cheers", name: "Ana" });
    assert.equal((await wall()).photos.length, 0);
    // The file isn't public while pending, whatever URL is tried.
    const file = t.wall.store.get(id)!.file;
    assert.equal((await t.get(`/photos/${file}`)).status, 404);
    assert.equal((await t.get(`/photos/${id}_t.jpg`)).status, 404);
    // Staff see it, with its thumbnail and image (staff only).
    const q = await queue();
    assert.deepEqual(q.pending.map((p) => p.id), [id]);
    assert.equal((await t.get(q.pending[0].thumbUrl, token)).status, 200);
    assert.equal((await t.get(q.pending[0].imageUrl)).status, 401);
    assert.equal((await t.get("/api/admin/moderation")).status, 401);

    const r = await t.send("POST", `/api/admin/photos/${id}/approve`, {}, token);
    assert.equal(r.status, 200);
    const w = await wall();
    assert.deepEqual(w.photos.map((p) => [p.id, p.caption, p.name, p.pinned]), [[id, "Cheers", "Ana", false]]);
    const img = await t.get(w.photos[0].url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.match(img.headers.get("cache-control") ?? "", /private/);
    assert.equal((await queue()).pending.length, 0);
  });

  test("approve + pin; pin and unpin; remove", async () => {
    const a = await sendPhoto(t);
    const b = await sendPhoto(t);
    await t.send("POST", `/api/admin/photos/${a}/approve`, { pin: true }, token);
    await t.send("POST", `/api/admin/photos/${b}/approve`, {}, token);
    let w = await wall();
    assert.deepEqual(w.photos.map((p) => [p.id, p.pinned]), [[a, true], [b, false]]);
    assert.equal((await t.send("POST", `/api/admin/photos/${a}/pin`, { pinned: false }, token)).status, 200);
    assert.equal((await t.send("POST", `/api/admin/photos/${b}/pin`, { pinned: true }, token)).status, 200);
    w = await wall();
    assert.deepEqual(w.photos.map((p) => [p.id, p.pinned]), [[a, false], [b, true]]);
    // Approved twice: refused. Reject an approved photo: refused (remove it instead).
    assert.equal((await t.send("POST", `/api/admin/photos/${a}/approve`, {}, token)).status, 409);
    assert.equal((await t.send("POST", `/api/admin/photos/${a}/reject`, {}, token)).status, 409);
    const file = t.wall.store.get(a)!.file;
    assert.equal((await t.send("DELETE", `/api/admin/photos/${a}`, null, token)).status, 200);
    assert.equal((await t.get(`/photos/${file}`)).status, 404);
    assert.ok(!existsSync(path.join(t.wall.store.photosDir, file)));
    assert.deepEqual((await wall()).photos.map((p) => p.id), [b]);
  });

  test("a pending photo can't be pinned", async () => {
    const a = await sendPhoto(t);
    assert.equal((await t.send("POST", `/api/admin/photos/${a}/pin`, { pinned: true }, token)).status, 409);
  });

  test("reject deletes the photo from the box", async () => {
    const id = await sendPhoto(t);
    const p = t.wall.store.get(id)!;
    assert.equal((await t.send("POST", `/api/admin/photos/${id}/reject`, {}, token)).status, 200);
    assert.equal(t.wall.store.get(id), undefined);
    assert.ok(!existsSync(path.join(t.wall.store.photosDir, p.file)));
    assert.ok(!existsSync(path.join(t.wall.store.photosDir, p.thumb)));
    // Again (another staff member got there first): a clear 404.
    assert.equal((await t.send("POST", `/api/admin/photos/${id}/reject`, {}, token)).status, 404);
  });

  test("pause new uploads", async () => {
    assert.equal((await t.send("PUT", "/api/admin/paused", { paused: true }, token)).status, 200);
    const r = await t.upload(await makePhoto(300, 300));
    assert.equal(r.status, 423);
    assert.equal((await json<{ code: string }>(r)).code, "paused");
    assert.equal((await json<{ paused: boolean }>(t.get("/api/config"))).paused, true);
    assert.equal((await wall()).paused, true);
    await t.send("PUT", "/api/admin/paused", { paused: false }, token);
    await sendPhoto(t);
  });

  test("clear the wall deletes everything, waiting and approved", async () => {
    const a = await sendPhoto(t);
    await sendPhoto(t);
    await t.send("POST", `/api/admin/photos/${a}/approve`, {}, token);
    assert.equal((await t.send("POST", "/api/admin/clear", {}, token)).status, 400, "needs the confirmation");
    const r = await json<{ removed: number }>(t.send("POST", "/api/admin/clear", { confirm: "clear" }, token));
    assert.equal(r.removed, 2);
    assert.equal((await wall()).photos.length, 0);
    assert.equal((await queue()).pending.length, 0);
    assert.deepEqual(readdirSync(t.wall.store.photosDir), []);
  });

  test("the wall honours show captions / names, and leaves the hidden ones out entirely", async () => {
    const a = await sendPhoto(t, { caption: "Hi", name: "Bo" });
    await t.send("POST", `/api/admin/photos/${a}/approve`, {}, token);
    await t.send("PUT", "/api/admin/settings", { showNames: false }, token);
    let w = await wall();
    assert.deepEqual([w.photos[0].caption, w.photos[0].name, w.showNames], ["Hi", "", false]);
    await t.send("PUT", "/api/admin/settings", { showNames: true, showCaptions: false }, token);
    w = await wall();
    assert.deepEqual([w.photos[0].caption, w.photos[0].name], ["", "Bo"]);
    await t.send("PUT", "/api/admin/settings", { showCaptions: true }, token);
  });

  test("an unchanged wall answers 304", async () => {
    const r1 = await t.get("/api/wall");
    const etag = r1.headers.get("etag")!;
    assert.equal((await t.get("/api/wall", undefined, { "if-none-match": etag })).status, 304);
    const id = await sendPhoto(t);
    // A pending photo doesn't change what the TV shows...
    assert.equal((await t.get("/api/wall", undefined, { "if-none-match": etag })).status, 304);
    await t.send("POST", `/api/admin/photos/${id}/approve`, {}, token);
    // ...an approval does.
    assert.equal((await t.get("/api/wall", undefined, { "if-none-match": etag })).status, 200);
  });

  test("patrons see their own photos' status", async () => {
    const a = await sendPhoto(t);
    const b = await sendPhoto(t);
    await t.send("POST", `/api/admin/photos/${a}/approve`, {}, token);
    await t.send("POST", `/api/admin/photos/${b}/reject`, {}, token);
    const r = await json<{ statuses: Record<string, string> }>(t.get(`/api/mine?ids=${a},${b},nonsense`));
    assert.deepEqual(r.statuses, { [a]: "approved", [b]: "gone" });
  });

  test("admin state and settings", async () => {
    const s = await json<AdminState>(t.get("/api/admin/state", token));
    assert.equal(s.onBox, false);
    assert.equal(s.settings.retentionDays, 7);
    assert.equal((await t.send("PUT", "/api/admin/settings", { retentionDays: 40 }, token)).status, 400);
    assert.equal((await t.send("PUT", "/api/admin/settings", { uploadsPerHour: 2 }, token)).status, 200);
    assert.equal((await json<{ uploadsPerHour: number }>(t.get("/api/config"))).uploadsPerHour, 2);
    await t.send("PUT", "/api/admin/settings", { uploadsPerHour: 5 }, token);
  });
});

describe("privacy: photos leave the box", () => {
  let t: TestApp;
  let token: string;
  before(async () => {
    t = await startApp();
    token = await t.login();
  });
  after(() => t.stop());

  test("after N days (default 7), waiting or approved", async () => {
    const old = await sendPhoto(t);
    await t.send("POST", `/api/admin/photos/${old}/approve`, {}, token);
    t.clock.now += 6 * 24 * 3600 * 1000;
    const newer = await sendPhoto(t);
    assert.equal(await t.wall.store.sweep(), 0);
    t.clock.now += 1 * 24 * 3600 * 1000 + 1000;
    assert.equal(await t.wall.store.sweep(), 1);
    assert.equal(t.wall.store.get(old), undefined);
    assert.ok(t.wall.store.get(newer));
    // A shorter setting applies at once.
    await t.send("PUT", "/api/admin/settings", { retentionDays: 1 }, token);
    assert.equal(t.wall.store.get(newer), undefined);
    assert.deepEqual(readdirSync(t.wall.store.photosDir), []);
    await t.send("PUT", "/api/admin/settings", { retentionDays: 7 }, token);
  });

  test("the storage cap removes the oldest first (pinned last)", async () => {
    t.wall.limiter.clear();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      t.clock.now += 1000;
      ids.push(await sendPhoto(t));
    }
    await t.send("POST", `/api/admin/photos/${ids[0]}/approve`, { pin: true }, token);
    const each = t.wall.store.get(ids[1])!.bytes;
    // Room for about two and a half photos: the oldest unpinned (ids[1], ids[2]) go first.
    await t.wall.store.updateSettings({ storageMb: 100 });
    (t.wall.store as unknown as { settings: { storageMb: number } }).settings.storageMb = (each * 2.5) / (1024 * 1024);
    await t.wall.store.sweep();
    assert.deepEqual(
      ids.map((id) => !!t.wall.store.get(id)),
      [true, false, false, true],
    );
  });
});

describe("restart", () => {
  test("photos, statuses and settings survive; stray files are tidied", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "photowall-restart-"));
    try {
      let t = await startApp({ dataDir });
      const token = await t.login();
      const a = await sendPhoto(t, { caption: "Kept" });
      const b = await sendPhoto(t);
      await t.send("POST", `/api/admin/photos/${a}/approve`, { pin: true }, token);
      await t.send("PUT", "/api/admin/settings", { slideSeconds: 12 }, token);
      await t.stop();
      // A crash left a file with no record.
      writeFileSync(path.join(dataDir, "photos", "0123456789abcdef0123.jpg"), "junk");
      t = await startApp({ dataDir });
      assert.equal(t.wall.store.get(a)?.status, "approved");
      assert.equal(t.wall.store.get(a)?.pinned, true);
      assert.equal(t.wall.store.get(a)?.caption, "Kept");
      assert.equal(t.wall.store.get(b)?.status, "pending");
      assert.equal(t.wall.store.getSettings().slideSeconds, 12);
      assert.ok(!existsSync(path.join(dataDir, "photos", "0123456789abcdef0123.jpg")));
      await t.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
