# Photo Wall for the Bar Games box: brief

**You are building an app module** that works **only on a Bar Games box** (hence the
"Venuebox" name): it relies on the venue's TVs, staff moderation and the box's admin. The
platform lives in `C:\CodeProjects\GameBroker` (public repo thezigpc/venueplay).

**What it is:** patrons send photos from their phones. Staff approve them. Approved photos
show on the TVs as a slideshow with the venue's branding, optionally with a caption and the
sender's first name.

**Moderation is the core of this app, not a feature.** Nothing a patron uploads reaches a TV
until a staff member approves it. Venues put this on screens in public.

**Read first:**
- `C:\CodeProjects\GameBroker\docs\SDK.md` and `C:\CodeProjects\GameBroker\integration\README.md`
  (vendor SDK 0.14.0 or newer).
- **An app to copy patterns from:** `C:\CodeProjects\MenuModule`. It has uploads, image
  handling, the TV slideshow, the admin with the box password, Docker and the publish
  workflow. Read its `CLAUDE.md` and `BARGAMES.md`. Don't edit it.
- **GameKit:** `C:\CodeProjects\GameKit` (`CHANGELOG.md`).

**Don't edit** GameBroker, GameKit or other modules. Send platform needs to the GameBroker
session as "SDK requests".

## What to build (0.1.0)

- **Manifest:**
  - **Basics:** `id: "photowall"`, `name: "Photo Wall"`, `kind: "app"`, `port: 3014`,
    `routing.basePath: true`.
  - **Routes:** `player: "/"` (send a photo), `table: "/tv"` (the slideshow), `host: "/host"`
    (the staff moderation queue), `admin: "/admin"`.
  - **Events:** `x-photowall-approved` (scenes can flash the lights for a new photo).
- **Patron:**
  - **sending:** pick or take a photo, an optional caption (short, with a profanity filter),
    an optional first name;
  - **limits:** max N photos per phone per hour;
  - **feedback:** "Sent! Staff will check it before it shows."
- **Uploads:**
  - re-encode on the server to JPEG/WebP, max 1920 px;
  - **strip EXIF** (location, device);
  - reject non-images and oversized files;
  - store in `/data`, with a size cap and the oldest removed first.
- **Staff (host page, needs staff sign-in through the box):**
  - the pending queue with approve, reject and "approve + pin";
  - approved photos: remove, pin and unpin;
  - "pause new uploads", and "clear the wall" (end of the night).
- **TV:**
  - the slideshow of approved photos (pinned ones more often), captions and names if given;
  - the venue's theme, plus a "Send your photo" QR and short link in a corner;
  - when the wall is empty, an inviting "Be the first" slide.
- **Privacy:**
  - photos are deleted after N days (default 7, a setting) and on "clear the wall";
  - the admin page says patrons' photos stay on this box only.

## Reporting back

Ask the user before creating the GitHub repo (suggested `thezigpc/venuebox-photowall`, public
image `ghcr.io/thezigpc/venuebox-photowall:<version>`). When 0.1.0 is published, reply to
"GameBroker Session" with the version, commit, publish run, tests and any SDK requests. Don't
touch the box. When testing on this PC: check that ports are free first, and stop only the
processes on your own ports, never by name.
