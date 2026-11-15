import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3014);
/** Built client, served by this process. */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Everything written at runtime: admin.json, settings.json, photos.json, photos/. */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(here, "../../data"));
/** Overrides the password chosen on the admin's setup screen (standalone). */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
/** Standalone name ("Photo Wall" by default; the admin's name setting wins, the venue's name on a box). */
export const GAME_NAME = process.env.GAME_NAME ?? "";
