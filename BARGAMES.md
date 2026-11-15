# Bar Games integration: Photo Wall (app)

**Level 2, `kind: "app"`, SDK 0.15.0, game kit 0.8.0.** Patrons send photos from their phones,
staff approve them, and approved photos play on the venue's TVs. Built for the box: it uses the
TVs, staff sign-in through the box and the box's admin password.

## Manifest
`bargames.json`: id `photowall`, `kind: "app"`, port 3014, `routing.basePath: true`.
- **Routes:** `player` `/` (send a photo), `table` `/tv` (the slideshow), `host` `/host`
  (staff moderation queue), `admin` `/admin` (settings).
- **Events:** `x-photowall-approved`. **Commands:** none.
- **Other:** `network.internet: false` (nothing leaves the box), `env.DATA_DIR=/data`, memory `384m`.

`npx bargames validate .` passes, with the expected "not pinned by digest" warning.

## `npx bargames check` (mock box `--base /photowall`, server on spare port 3114)
```
photowall@0.1.0 · level 2 · http://127.0.0.1:3114
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("Photo Wall (mock)")
✓ /__bargames/theme.css served
✓ phone page (routes.player) / → 200
✓ TV view (routes.table) /tv → 200

all checks passed
```
On Windows with Node 24, the CLI then prints the known libuv `Assertion failed … async.c`
line as it exits, after the result.

## Events
**`x-photowall-approved`** is sent when staff approve a photo (`server/src/app.ts`, the
`/photos/:id/approve` route), so a scene can flash the lights. No room and no session kind.
Its `data` is `{ photoId, pinned, onWall }`:
- `photoId`: a random id;
- `pinned`: whether it was "approve + pin";
- `onWall`: how many photos are on the wall now.

It carries no names, captions or IPs.

**Attention** (`bg.setAttention`, `server/src/bargames.ts`): while photos wait, the Tonight page
shows "N photos waiting for approval" with Open → `/host`, and "Photo uploads are paused" while
staff have paused uploads. It's sent only when that text changes, 1.5 s after the last change.

## Moderation (the core of the app)
- **Waiting photos are never public.**
  - `/photos/<id>.jpg` serves approved photos only, and checks the store on every request.
  - Staff fetch waiting photos from `/api/admin/photos/<id>/{image,thumb}`, which needs their
    token.
  - `/api/wall` lists approved photos only.
  - Tests check that a waiting photo is unreachable under any URL.
- **Signing in to `/host` and `/admin`** (the same sign-in for both, using the kit's admin
  auth):
  - staff coming from the box admin are signed in by the box (`trusted: bg.isStaff`);
  - the box's admin password also works (`venuePassword` with `onBox`);
  - guests can't set a password first (setup returns 403 on a box);
  - standalone, the app has its own password and a first-run setup.
- **Host page actions:**
  - waiting photos: approve, approve + pin, reject (the photo is deleted);
  - photos on the wall: pin/unpin, remove (the photo is deleted);
  - "Pause new uploads": the phone page says uploads are paused, and the TV hides its QR code;
  - "Clear the wall": deletes every photo, waiting and approved, after a confirm step. The
    request must include `{"confirm":"clear"}`.

## Uploads
- **Re-encoding** (`server/src/images.ts`, sharp): every photo becomes a fresh JPEG, at most
  1920 px, auto-rotated from EXIF.
  - Re-encoding drops all EXIF, XMP and IPTC data (GPS location, device). A test reads the
    stored file back to check.
  - Alpha is flattened, and the color is converted to sRGB.
  - A 480 px thumbnail is made for staff.
  - Only one photo is processed at a time, to keep memory low.
- **Rejected:**
  - non-images and SVG (415);
  - photos over 50 MP;
  - photos under 64 px;
  - uploads over 15 MB (413, checked on the declared length before the body is read).
- **The phone also shrinks the photo** before sending (canvas, to 2560 px), so uploads stay
  around 1 MB on venue Wi-Fi. If the browser can't decode the file, the original goes and the
  server does the work.
- **Captions** (≤ 80 characters) **and first names** (one word of letters, ≤ 20) go through
  `shared/src/text.ts`:
  - a word filter that also catches leetspeak, repeated letters and spaced-out words, while
    leaving "cocktail", "Negroni", "Pornstar martini", "Scunthorpe" and "shiitake" alone;
  - no links and no phone numbers.

  The phone runs the same checks before uploading.
- **Limits** (`server/src/rateLimit.ts`), counted in memory:
  - N photos per phone per hour (default 5). The phone is a random device id kept in
    localStorage, stored only as a hash.
  - Each address may send 4 × N, so clearing the browser doesn't get around the limit.
  - Addresses come from `bg.clientIp`, so on a box each device on the Wi-Fi counts separately,
    and gateway headers are ignored standalone. Both cases are tested.
  - Refused uploads don't count toward the limit.
  - At most 300 photos may wait for staff; after that the phone page asks people to try later.
- **Storage:**
  - files live in `/data/photos`;
  - there's a size cap (default 1000 MB, a setting) and a cap of 2000 photos;
  - the oldest photos are removed first, pinned photos last.

## Privacy
- Photos are deleted N days after they were sent (default 7, a setting; checked every 10
  minutes and when the setting is shortened), and on reject, remove and "clear the wall".
- The admin page says "Patrons' photos stay on this box only", along with the rest of the
  rules. The phone page says the same in its fine print.
- `network.internet: false`.
- What leaves the server:
  - the wall carries a caption or name only when its setting is on;
  - the phone page can ask only about photo ids it was given.

## Path routing (`/photowall/`)
As in the menu:
- `serveSpa(…, basePath: bg.basePath)`, and Vite builds with `base: "./"`;
- every fetch and image URL goes through `bgUrl()`;
- `main.tsx` strips `basePath()` before it picks the page.

Tests: `server/test/basepath.test.ts`.

The storage keys `photowall.*` hold the staff token, device id, last name, sent ids and the
last wall. The app sets no cookies and has no service worker.

## TV view (`/tv`): step 7 checklist
- [x] The URL alone shows the wall: no prompt, no gesture.
- [x] No audio.
- [x] Fills 1920×1080 with no scrolling.
  - Text is scaled to the 16:9 height: captions 5.2 units, names 3.6, the QR label 3.2, the
    announcement 4.6.
  - Portrait photos get a blurred copy of themselves behind them instead of black bars.
- [x] Recovers on its own:
  - polls `/api/wall` every 5 s, and an unchanged wall costs a 304;
  - backs off to 60 s while the server is unreachable;
  - keeps the last good wall in memory and localStorage;
  - skips photos that won't load for a minute, and keeps the current photo on screen if none
    load;
  - reloads on a new client build, and 10 s after a render crash.
- [x] Light animation: one 1.2 s fade per photo, static otherwise.
- [x] Nothing needs a pointer. On a box `tableMode(ctx)` is on (the shared-screen marker was
  checked); standalone the page keeps its own wake lock.
- [x] **Rotation** (`shared/src/rotation.ts`, tested):
  - a newly approved photo goes up at the next change, newest first;
  - the wall then cycles in a shuffled order, with pinned photos coming round N times per cycle
    (default 3), spread out;
  - the same photo never shows twice in a row while there are others.
- [x] **The corner** has a QR code and short address, `joinDisplay(ctx, "/")`, under "Send your
  photo". It's hidden while uploads are paused.
- [x] **The empty wall** shows a "Be the first on the wall!" slide with a big QR code. While
  uploads are paused it says "The photo wall is taking a break" instead.
- [x] **The staff announcement** is drawn by the app itself, following `show` and `position`. A
  bottom strip lifts the caption and the QR code above it.

## Checked by hand on the mock box (`--base /photowall`, headless Chrome)
These steps were run in headless Chrome:
1. Opened the TV while the wall was empty: the "Be the first" slide, in the mock theme, with the
   announcement strip.
2. Sent two photos from the phone (390 px wide): a 3000×4000 photo with GPS data and a caption
   and name, and a landscape photo. The phone said "Sent! Staff will check it before it shows."
3. Tried a "sh1t" caption: the phone refused it before uploading.
4. Opened `/__bargames/staff?next=/photowall/host`: staff were signed in by the box, and the
   queue listed both photos.
5. Chose "Approve + pin" on the first photo. The mock box printed the event and the attention
   updates.
6. The TV showed the photo within a few seconds, with "Happy birthday Jo! 🎉 — Sam" and the
   corner QR code.
7. The phone's "Your photos" read "Waiting for staff" and "On the wall".
8. Opened the admin page.

There were no console errors and no 4xx or 5xx responses.

## Tests (`npm test`: 50 pass)
- **Shared:** the word filter, captions and names, settings limits, rotation.
- **Server, standalone:**
  - the upload → approve → wall flow;
  - EXIF removed, rotation applied, PNG and WebP converted to JPEG;
  - refusals: non-images, SVG, tiny, empty, oversized;
  - caption and name filtering;
  - the per-phone limit (and the hour rolling over), refused uploads not counting, the
    per-address cap;
  - pin/unpin, approve + pin, reject and remove deleting files, pause, clear;
  - the caption and name settings, ETag/304, `/api/mine`;
  - retention (including a shortened setting), the storage cap order, a restart (stray files
    tidied).
- **Server with a fake box core:**
  - the venue's name;
  - status `{ rooms: [] }`;
  - box password, staff sign-in, guests refused at setup;
  - per-device addresses through the gateway;
  - the event's data, attention set and cleared, the paused attention item.
- **Standalone only:** `venue.json` says `standalone: true`, the name comes from `GAME_NAME`
  and then the admin setting, gateway headers are ignored, and `/__bargames/status` needs the
  token.

## Container
- Writes only under `/data`: `admin.json`, `settings.json`, `photos.json`, `photos/*.jpg`.
- Multi-stage `Dockerfile`, `USER node`, `/data` chowned, `linux/amd64` via the workflow.
- The clean-checkout build is the publish workflow's build on GitHub (this PC has no Docker).
- **Tested on a Linux Docker host** (2026-11-15). This was a throwaway run of the published
  image, removed afterwards:
  - `docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
    --memory 384m -v vol:/data`: started, and `/health` answered. Image size 391 MB.
  - It runs as uid 1000. Writing to `/app` fails (read-only file system).
  - An 11.7 MB, 24-megapixel JPEG with GPS data was stored as 1920×1280 with no EXIF; the
    thumbnail had none either. A portrait photo became 1440×1920.
  - Memory afterwards was 95 MiB of 384 MiB. It wasn't killed for memory and didn't restart.

## Image
- `ghcr.io/thezigpc/venuebox-photowall:<version>`, published by
  `.github/workflows/publish-image.yml` (the snippet, unchanged).
- Repo: https://github.com/thezigpc/venuebox-photowall (public). The package is public too: an
  anonymous pull of 0.1.0 returned 200.

## SDK requests
- **Emoji on TVs:** does the box's casting Chromium have an emoji font? Patrons will put emoji
  in captions; without the font they show as boxes. If not, could the box image add
  `fonts-noto-color-emoji`?
- **Nice to have:** a standard way for an app to say "N things waiting for staff" as a badge
  on the box's Apps tab or iPad, not only a Tonight attention item. For now the attention item
  does the job.
