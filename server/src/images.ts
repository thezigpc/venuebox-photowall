// Patron photos: checked, turned upright, shrunk to at most 1920 px, and always re-encoded as
// a fresh JPEG. Re-encoding drops every bit of metadata the phone wrote (GPS location, device
// model, time, thumbnails), and anything hidden in the original file along with it.

import sharp from "sharp";
import { MAX_PHOTO_PX } from "@photowall/shared";

// One image at a time and no cache: the container's memory is limited.
sharp.cache(false);
sharp.concurrency(1);

/** About 50 megapixels: more than any phone camera's JPEG, far short of a decompression bomb. */
const MAX_INPUT_PIXELS = 50_000_000;
export const THUMB_PX = 480;

/** What phones send: JPEG, PNG, WebP, HEIC/AVIF (when the build can read it), GIF (first frame). */
const ACCEPTED = new Set(["jpeg", "png", "webp", "heif", "avif", "gif", "tiff"]);

export class UploadError extends Error {}

export interface ProcessedPhoto {
  data: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

// Several phones uploading at once would each decode a big photo: queue them instead.
let chain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  return oneAtATime(() => encode(input));
}

async function encode(input: Buffer): Promise<ProcessedPhoto> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new UploadError("That file isn't a photo we can read. Send a JPG or PNG.");
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) throw new UploadError("That file isn't a photo. Send a JPG or PNG.");
  if (!meta.width || !meta.height) throw new UploadError("That photo has no size.");
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new UploadError("That photo is far too large.");
  if (meta.width < 64 || meta.height < 64) throw new UploadError("That photo is too small to show on a TV.");

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // upright from the EXIF orientation, which is then dropped with the rest
      .resize({ width: MAX_PHOTO_PX, height: MAX_PHOTO_PX, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#000000" })
      .toColourspace("srgb")
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await sharp(data).resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    return { data, thumb, width: info.width, height: info.height };
  } catch {
    throw new UploadError("That photo couldn't be processed. Try another one.");
  }
}
