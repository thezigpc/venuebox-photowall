// Bar Games: standalone stays standalone; on a (fake) box the venue's name, the approval
// event, the attention item and staff sign-in through the box.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { fakeCore, makePhoto, startApp, TOKEN, type FakeCore, type TestApp } from "./helpers.js";

/** What the box's gateway adds for a browser signed in to the box admin. */
const STAFF = { "x-bargames-via": "1", "x-bargames-staff": "1" };
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await wait(20);
  }
}

describe("standalone", () => {
  let t: TestApp;
  before(async () => (t = await startApp({ gameName: "Kava Photos" })));
  after(() => t.stop());

  test("venue.json says standalone and the name is GAME_NAME", async () => {
    const v = await json<{ standalone: boolean }>(t.get("/__bargames/venue.json"));
    assert.equal(v.standalone, true);
    assert.equal((await json<{ gameName: string }>(t.get("/api/config"))).gameName, "Kava Photos");
  });

  test("the admin's name setting wins standalone", async () => {
    const token = await t.login();
    await t.send("PUT", "/api/admin/settings", { name: "The Root Bar" }, token);
    assert.equal((await json<{ gameName: string }>(t.get("/api/config"))).gameName, "The Root Bar");
    assert.equal((await json<{ name: string }>(t.get("/api/wall"))).name, "The Root Bar");
  });

  test("gateway staff headers are ignored standalone", async () => {
    const status = await json<{ trusted: boolean; venueLogin: boolean }>(t.get("/api/admin/status", undefined, STAFF));
    assert.equal(status.trusted, false);
    assert.equal(status.venueLogin, false);
    assert.equal((await t.send("POST", "/api/admin/trusted", null, undefined, STAFF)).status, 403);
    assert.equal((await t.send("POST", "/api/admin/login", { password: "box-password" })).status, 401);
  });

  test("the rate limit reads the address the SDK gives (gateway headers ignored standalone)", async () => {
    // Twenty different "client IPs" from a spoofed header are still one address standalone.
    t.wall.limiter.clear();
    for (let i = 0; i < 20; i++) {
      const r = await t.upload(await makePhoto(200, 200), { headers: { "x-bargames-client-ip": `10.0.0.${i}` } });
      assert.equal(r.status, 200);
    }
    assert.equal((await t.upload(await makePhoto(200, 200), { headers: { "x-bargames-client-ip": "10.0.0.99" } })).status, 429);
  });

  test("status needs the box's token", async () => {
    assert.equal((await t.get("/__bargames/status")).status, 401);
  });
});

describe("on a box", () => {
  let core: FakeCore;
  let t: TestApp;
  before(async () => {
    core = await fakeCore();
    t = await startApp({ coreUrl: core.url, token: TOKEN, gameName: "Kava Photos" });
  });
  after(async () => {
    await t.stop();
    await core.close();
  });

  test("the venue's name for the app; status lists no rooms", async () => {
    assert.equal((await json<{ gameName: string }>(t.get("/api/config"))).gameName, "Photo Wall at Test Bar");
    assert.equal((await json<{ name: string }>(t.get("/api/wall"))).name, "Photo Wall at Test Bar");
    const r = await fetch(t.url + "/__bargames/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual(await r.json(), { rooms: [] });
  });

  test("guests can't claim the staff pages; the box's password and staff sign-in work", async () => {
    const guest = await json<{ venueLogin: boolean; setupAllowed: boolean }>(t.get("/api/admin/status"));
    assert.deepEqual([guest.venueLogin, guest.setupAllowed], [true, false]);
    assert.equal((await t.send("POST", "/api/admin/setup", { password: "guest-grabs-it" })).status, 403);
    assert.equal((await t.send("POST", "/api/admin/login", { password: "box-password" })).status, 200);
    const staff = await json<{ token: string }>(t.send("POST", "/api/admin/trusted", null, undefined, STAFF));
    assert.equal((await t.get("/api/admin/moderation", staff.token)).status, 200);
    // Without the gateway's word there's no shortcut.
    assert.equal((await t.send("POST", "/api/admin/trusted", null, undefined, { "x-bargames-staff": "1" })).status, 403);
  });

  test("each phone on the venue Wi-Fi has its own address for the limit", async () => {
    t.wall.limiter.clear();
    // Thirty phones, all with fresh device ids, each from its own address: none blocked.
    for (let i = 0; i < 30; i++) {
      const r = await t.upload(await makePhoto(200, 200), { headers: { "x-bargames-via": "1", "x-bargames-client-ip": `192.168.1.${i + 10}` } });
      assert.equal(r.status, 200);
    }
    t.wall.limiter.clear();
  });

  test("approving emits x-photowall-approved; waiting photos are an attention item", async () => {
    const staff = await json<{ token: string }>(t.send("POST", "/api/admin/trusted", null, undefined, STAFF));
    await t.send("POST", "/api/admin/clear", { confirm: "clear" }, staff.token);
    await until(() => JSON.stringify(core.attention.at(-1)) === "[]");

    const up = await json<{ id: string }>(t.upload(await makePhoto(400, 300)));
    await until(() => JSON.stringify(core.attention.at(-1)) === JSON.stringify([{ level: "info", message: "1 photo waiting for approval", actionPath: "/host" }]));

    assert.equal((await t.send("POST", `/api/admin/photos/${up.id}/approve`, { pin: true }, staff.token)).status, 200);
    await until(() => core.events.some((e) => e.type === "x-photowall-approved"));
    const evt = core.events.find((e) => e.type === "x-photowall-approved")!;
    assert.deepEqual(evt.data, { photoId: up.id, pinned: true, onWall: 1 });
    await until(() => JSON.stringify(core.attention.at(-1)) === "[]");

    await t.send("PUT", "/api/admin/paused", { paused: true }, staff.token);
    await until(() => JSON.stringify(core.attention.at(-1)) === JSON.stringify([{ level: "info", message: "Photo uploads are paused", actionPath: "/host" }]));
    await t.send("PUT", "/api/admin/paused", { paused: false }, staff.token);
  });
});
