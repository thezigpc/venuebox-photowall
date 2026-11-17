# Photo Wall: project notes

Patrons send photos from their phones; staff approve them; approved photos play on the venue's
TVs as a slideshow. An **app module for a Bar Games box** (`kind: "app"`, id `photowall`, port
3014). It also runs standalone for development, but it's built for the box: its TVs, staff
moderation and the box's admin.

**Moderation is the core, not a feature.** Nothing a patron uploads may reach a TV, or any
public URL, until staff approve it. Keep it that way in every change:
- `/photos/<id>.jpg` serves approved photos only (checked against the store on every request);
- waiting photos are reachable only through `/api/admin/photos/<id>/{image,thumb}` with a staff token;
- `/api/wall` lists approved photos only.

## Where things are
- Brief: `BRIEF.md`. Box integration report: `BARGAMES.md`.
- Platform: `C:\CodeProjects\GameBroker` (docs/SDK.md, integration/README.md). **Don't edit it**,
  nor GameKit (`C:\CodeProjects\GameKit`) or other modules. Platform needs go to the GameBroker
  session (ListAgents; its name starts with "GameBroker") as "SDK requests".
- Pattern source: `C:\CodeProjects\MenuModule` (read only).
- Vendored: `vendor/bargames-sdk-0.15.0.tgz`, `vendor/bargames-gamekit-0.10.3.tgz`. New versions
  arrive under new file names; never overwrite a tarball (the lockfile pins its hash).

## Layout
npm workspaces, TypeScript, Express 4, React 18 + Vite 5, Node 22, tests with `node:test` via tsx.
- `shared/`: types, settings (limits), the caption/name filter (`text.ts`), the TV rotation (`rotation.ts`).
- `server/`: `app.ts` (routes), `photoStore.ts` (photos.json + files, retention, storage cap,
  clear), `images.ts` (sharp: re-encode to JPEG ≤1920 px, EXIF dropped, thumbnail),
  `rateLimit.ts` (per phone per hour, looser per address), `bargames.ts` (event, attention).
- `client/`: `/` PhonePage, `/tv` TvPage, `/host` HostPage (queue), `/admin` AdminPage.
  `StaffGate` signs staff in (box staff sign-in, the box password, or the app's own).

## Data (`DATA_DIR`, `/data` in the container)
`admin.json`, `settings.json`, `photos.json`, `photos/<id>.jpg` + `photos/<id>_t.jpg`.

## Testing on this PC
- `npm test`, `npm run typecheck`, `npm run build`.
- Mock box: `MSYS_NO_PATHCONV=1 npx bargames mock-box . --base /photowall --game http://127.0.0.1:3114 --port 7284 --core-port 7294`,
  then the server with the env it prints, `PORT=3114`, and `DATA_DIR` set to a **Windows** path
  (a Git Bash `/c/...` path becomes `C:\c\...` in Node).
- Other sessions run servers too: check ports are free first, and stop only the PIDs on your
  own ports, never processes by name.
- Releases: commit, push `main` and publish without asking (the user's standing OK,
  2026-11-17). Bump `version` and the `image` tag together. Never touch the box itself.
