// Test helpers: an in-process app on a free port with its own data dir, a fake box core, and
// photos made on the fly.

import { mkdtempSync, rmSync } from "node:fs";
import http, { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp, type WallApp } from "../src/app.js";
import { makeBarGames } from "../src/bargames.js";

export async function makePhoto(
  width: number,
  height: number,
  opts: { format?: "jpeg" | "png" | "webp"; gps?: boolean; orientation?: number } = {},
): Promise<Buffer> {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } });
  if (opts.gps) {
    img = img.withExif({
      IFD0: { Make: "TestPhone", Model: "TestPhone 15", Software: "Camera 1.0" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 36/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "82/1 33/1 0/1" },
    });
  }
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.toFormat(opts.format ?? "jpeg").toBuffer();
}

export const TOKEN = "test-token";

export interface FakeCore {
  url: string;
  events: { type: string; data?: Record<string, unknown> }[];
  attention: unknown[][];
  close(): Promise<void>;
}

/** A pretend box core: venue context, events, attention and the box's admin password. */
export async function fakeCore(): Promise<FakeCore> {
  const core: FakeCore = { url: "", events: [], attention: [], close: async () => undefined };
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = () => (body ? JSON.parse(body) : {});
      if (req.url === "/internal/venue") {
        const theme = { colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" } };
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(
          JSON.stringify({
            protocol: 1,
            venue: { name: "Test Bar", theme, playUrl: "https://play.testbar.example" },
            game: { id: "photowall", displayName: "Photo Wall at Test Bar", theme, publicUrl: "https://play.testbar.example/photowall" },
            standalone: false,
            generatedAt: new Date().toISOString(),
          }),
        );
      }
      if (req.url === "/internal/events") {
        core.events.push(json());
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/attention") {
        core.attention.push(json().items);
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/venue-password") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ ok: json().password === "box-password" }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  core.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  core.close = () => new Promise((r) => srv.close(() => r()));
  return core;
}

export interface TestApp {
  url: string;
  wall: WallApp;
  dataDir: string;
  clock: { now: number };
  get(path: string, token?: string, headers?: Record<string, string>): Promise<Response>;
  send(method: string, path: string, body: unknown, token?: string, headers?: Record<string, string>): Promise<Response>;
  /** A patron's upload. */
  upload(img: Buffer, opts?: { caption?: string; name?: string; device?: string; headers?: Record<string, string> }): Promise<Response>;
  /** Sets the admin password up (standalone) and returns a session token. */
  login(): Promise<string>;
  stop(): Promise<void>;
}

let deviceSeq = 0;
/** A fresh device id per call, like a new phone. */
export const newDevice = () => `test-device-${String(++deviceSeq).padStart(8, "0")}`;

export async function startApp(
  opts: { coreUrl?: string; token?: string; adminPassword?: string; gameName?: string; clientDist?: string; basePath?: string; dataDir?: string } = {},
): Promise<TestApp> {
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "photowall-test-"));
  const clock = { now: Date.parse("2026-11-14T20:00:00Z") };
  const bg = makeBarGames({ defaultName: opts.gameName || "Photo Wall", coreUrl: opts.coreUrl ?? "", token: opts.token ?? "" });
  const wall = await createApp({
    dataDir,
    bg,
    adminPassword: opts.adminPassword,
    gameName: opts.gameName,
    clientDist: opts.clientDist,
    basePath: opts.basePath,
    now: () => clock.now,
    attentionDelayMs: 0,
  });
  const server: Server = createServer(wall.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
  const t: TestApp = {
    url,
    wall,
    dataDir,
    clock,
    get: (p, token, headers = {}) => fetch(url + p, { headers: { ...auth(token), ...headers } }),
    send: (method, p, body, token, headers = {}) =>
      body === null
        ? fetch(url + p, { method, headers: { ...auth(token), ...headers } })
        : fetch(url + p, { method, headers: { "content-type": "application/json", ...auth(token), ...headers }, body: JSON.stringify(body) }),
    upload: (img, o = {}) =>
      fetch(url + "/api/photos", {
        method: "POST",
        headers: {
          "content-type": "image/jpeg",
          "x-photowall-device": o.device ?? newDevice(),
          ...(o.caption !== undefined ? { "x-photowall-caption": encodeURIComponent(o.caption) } : {}),
          ...(o.name !== undefined ? { "x-photowall-name": encodeURIComponent(o.name) } : {}),
          ...o.headers,
        },
        body: new Uint8Array(img),
      }),
    async login() {
      const r = await t.send("POST", "/api/admin/setup", { password: "correct horse battery" });
      const body = (await r.json()) as { ok: boolean; token?: string; error?: string };
      if (body.token) return body.token;
      const l = (await (await t.send("POST", "/api/admin/login", { password: "correct horse battery" })).json()) as { token?: string; error?: string };
      if (!l.token) throw new Error(`login failed: ${body.error} / ${l.error}`);
      return l.token;
    },
    async stop() {
      wall.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (!opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return t;
}
