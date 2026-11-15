// What the server stores and what each page gets.

import type { Settings } from "./settings.js";

export type PhotoStatus = "pending" | "approved";

/** One patron photo, as stored in photos.json. Never sent to browsers as-is (`device`). */
export interface Photo {
  id: string;
  /** File names inside DATA_DIR/photos/: the re-encoded photo and a small thumbnail for staff. */
  file: string;
  thumb: string;
  width: number;
  height: number;
  /** Bytes on disk (photo + thumbnail), for the storage cap. */
  bytes: number;
  caption: string;
  name: string;
  status: PhotoStatus;
  pinned: boolean;
  createdAt: string;
  approvedAt: string | null;
  /** A hash of the sender's device id: only for the per-phone limit, never shown. */
  device: string;
}

/** A photo on the TV wall (approved only). */
export interface WallPhoto {
  id: string;
  /** Root-relative ("/photos/<file>"); the client adds the path prefix. */
  url: string;
  width: number;
  height: number;
  caption: string;
  name: string;
  pinned: boolean;
  approvedAt: string;
}

/** What the TV polls. */
export interface Wall {
  /** The client build the server serves: a TV reloads when it changes. */
  build: string;
  /** Changes whenever anything below changes. */
  version: string;
  name: string;
  paused: boolean;
  slideSeconds: number;
  pinnedWeight: number;
  showCaptions: boolean;
  showNames: boolean;
  photos: WallPhoto[];
  serverTime: number;
}

/** A photo as staff see it in the moderation queue. */
export interface StaffPhoto {
  id: string;
  /** Root-relative, need the staff token (fetched as a blob). */
  imageUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  caption: string;
  name: string;
  status: PhotoStatus;
  pinned: boolean;
  createdAt: string;
  approvedAt: string | null;
}

export interface StorageInfo {
  usedBytes: number;
  capBytes: number;
  photos: number;
  maxPhotos: number;
}

/** What the host (moderation) page polls. */
export interface Moderation {
  version: string;
  paused: boolean;
  /** Oldest first: the order staff work through them. */
  pending: StaffPhoto[];
  /** Newest approval first. */
  approved: StaffPhoto[];
  storage: StorageInfo;
}

/** The phone page's settings: what a patron needs to know before sending. */
export interface PublicConfig {
  gameName: string;
  paused: boolean;
  uploadsPerHour: number;
  retentionDays: number;
  maxCaption: number;
  maxName: number;
  maxUploadMb: number;
}

export interface AdminState {
  settings: Settings;
  storage: StorageInfo;
  counts: { pending: number; approved: number };
  onBox: boolean;
}

/** Status of a patron's own photos (they keep the ids the upload returned). */
export type MyPhotoStatus = "pending" | "approved" | "gone";
