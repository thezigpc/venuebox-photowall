# Photo Wall

A photo wall for venues running a Bar Games box. Patrons send photos from their phones. Staff
approve each one, and approved photos play on the venue's TVs with the venue's branding,
optionally with a caption and the sender's first name.

**Nothing a patron uploads reaches a TV until a staff member approves it.**

- `/`: the phone page. Take or choose a photo, add an optional caption and first name, and
  send it.
- `/tv`: the slideshow for the TVs, with a "Send your photo" QR code in the corner.
- `/host`: the staff moderation queue: approve, reject, pin, remove, pause uploads and clear
  the wall.
- `/admin`: the settings, plus what happens to patrons' photos.

## Privacy
Every photo is re-encoded on arrival, which removes its location and device details. Photos
stay on the box and are deleted after 7 days by default (a setting), and when staff reject or
remove them or clear the wall.

## Install on a box
Paste this repo's URL into the box's **Apps** tab. The box pulls
`ghcr.io/thezigpc/venuebox-photowall:<version>`.

## Development
```bash
npm install
npm run dev        # server :3014, client :5190
npm test
npm run build && npm start
```
Integration details are in [BARGAMES.md](BARGAMES.md).
