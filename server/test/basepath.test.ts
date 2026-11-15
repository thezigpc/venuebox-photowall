// SDK 0.10.0: the app under a path prefix (https://venue/photowall/). The proxy strips the
// prefix, so routes stay put; index.html carries it for the client.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, type TestApp } from "./helpers.js";

function fakeDist(): string {
  const dist = mkdtempSync(path.join(os.tmpdir(), "photowall-dist-"));
  mkdirSync(path.join(dist, "assets"));
  writeFileSync(path.join(dist, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"><script type="module" src="./assets/index-x.js"></script></head><body><div id="root"></div></body></html>');
  writeFileSync(path.join(dist, "assets", "index-x.js"), "console.log(1)");
  return dist;
}

const html = (t: TestApp, p: string) => t.get(p).then(async (r) => ({ status: r.status, body: await r.text() }));

describe("under a path prefix", () => {
  let t: TestApp;
  before(async () => (t = await startApp({ clientDist: fakeDist(), basePath: "/photowall" })));
  after(() => t.stop());

  test("every page gets the prefix injected", async () => {
    for (const p of ["/", "/tv", "/host", "/admin"]) {
      const r = await html(t, p);
      assert.equal(r.status, 200, p);
      assert.match(r.body, /<meta name="bargames-base" content="\/photowall"><base href="\/photowall\/">/, p);
    }
  });

  test("API and photos keep their unprefixed routes", async () => {
    assert.equal((await t.get("/assets/index-x.js")).status, 200);
    assert.equal((await t.get("/api/wall")).status, 200);
    assert.equal((await t.get("/api/nope")).status, 404);
    assert.equal((await t.get("/photos/0123456789abcdef0123.jpg")).status, 404);
  });
});

describe("at the root (no prefix)", () => {
  let t: TestApp;
  before(async () => (t = await startApp({ clientDist: fakeDist(), basePath: "" })));
  after(() => t.stop());

  test('index.html gets only <base href="/">', async () => {
    for (const p of ["/", "/tv/", "/host"]) {
      const r = await html(t, p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(r.body, /bargames-base/, p);
      assert.match(r.body, /<base href="\/">/, p);
    }
  });
});
