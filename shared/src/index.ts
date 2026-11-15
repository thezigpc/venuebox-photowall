export * from "./types.js";
export * from "./settings.js";
export * from "./text.js";
export * from "./rotation.js";

/** Upload limits, the same on the phone (to warn early) and the server (to enforce). */
export const MAX_UPLOAD_MB = 15;
/** Longest side of a stored photo. */
export const MAX_PHOTO_PX = 1920;
