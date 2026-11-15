// The admin's settings, with their limits. Everything stored goes through here, so a
// hand-edited or old settings.json can't put a nonsense value into effect.

export interface Settings {
  /** Standalone name (on a box the venue's name for the app wins). */
  name: string;
  /** Photos one phone may send in an hour. */
  uploadsPerHour: number;
  /** Photos are deleted this many days after they were sent. */
  retentionDays: number;
  /** How long each photo stays on the TV. */
  slideSeconds: number;
  /** Pinned photos come round this many times as often. */
  pinnedWeight: number;
  showCaptions: boolean;
  showNames: boolean;
  /** Total space for photos; the oldest go first when it's full. */
  storageMb: number;
  /** Staff paused new uploads (the host page's switch). */
  paused: boolean;
}

export const DEFAULT_NAME = "Photo Wall";

export const DEFAULT_SETTINGS: Settings = {
  name: "",
  uploadsPerHour: 5,
  retentionDays: 7,
  slideSeconds: 8,
  pinnedWeight: 3,
  showCaptions: true,
  showNames: true,
  storageMb: 1000,
  paused: false,
};

export const LIMITS = {
  uploadsPerHour: [1, 30],
  retentionDays: [1, 30],
  slideSeconds: [4, 60],
  pinnedWeight: [2, 5],
  storageMb: [100, 20000],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

export const MAX_NAME_SETTING = 60;

export type SettingsResult = { ok: true; value: Settings } | { ok: false; error: string };

const LABELS: Record<keyof typeof LIMITS, string> = {
  uploadsPerHour: "Photos per phone per hour",
  retentionDays: "Days to keep photos",
  slideSeconds: "Seconds per photo",
  pinnedWeight: "How often pinned photos show",
  storageMb: "Storage for photos (MB)",
};

/** Applies a patch from the admin page; refuses out-of-range values with a message. */
export function mergeSettings(current: Settings, patch: unknown): SettingsResult {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "Nothing to save." };
  const p = patch as Record<string, unknown>;
  const next: Settings = { ...current };
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (p[key] === undefined) continue;
    const v = Number(p[key]);
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(v) || v < min || v > max) return { ok: false, error: `${LABELS[key]}: a whole number from ${min} to ${max}.` };
    next[key] = v;
  }
  for (const key of ["showCaptions", "showNames", "paused"] as const) {
    if (p[key] === undefined) continue;
    if (typeof p[key] !== "boolean") return { ok: false, error: `${key} must be on or off.` };
    next[key] = p[key] as boolean;
  }
  if (p.name !== undefined) {
    if (typeof p.name !== "string") return { ok: false, error: "The name must be text." };
    const name = p.name.replace(/\s+/g, " ").trim();
    if (name.length > MAX_NAME_SETTING) return { ok: false, error: `The name can be at most ${MAX_NAME_SETTING} characters.` };
    next.name = name;
  }
  return { ok: true, value: next };
}

/** Settings from disk: anything missing or invalid falls back to the default, field by field. */
export function settingsFromStored(raw: unknown): Settings {
  let s: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const r = mergeSettings(s, { [k]: v });
    if (r.ok) s = r.value;
  }
  return s;
}
