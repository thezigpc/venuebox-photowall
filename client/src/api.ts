// HTTP helpers. Paths are written from the root ("/api/...") and go through bgUrl, which adds
// the prefix the page runs under on a box or behind a proxy ("/photowall/api/..."; SDK 0.10.0).

import { bgUrl } from "@bargames/sdk/client";
import type { AdminState, Moderation, MyPhotoStatus, PublicConfig, Settings, StaffPhoto } from "@photowall/shared";

const TOKEN_KEY = "photowall.staffToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: signed in until reload */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(bgUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch {
    throw new ApiError("Can't reach the server. Check the connection and try again.", 0);
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok) throw new ApiError(json?.error ?? `The server answered ${res.status}.`, res.status, json);
  return json as T;
}

export interface AuthStatus {
  setupNeeded: boolean;
  configured: boolean;
  broken: boolean;
  authenticated: boolean;
  minPasswordLength: number;
  /** On a box: the box's admin password signs in; show the sign-in form first. */
  venueLogin?: boolean;
  /** Whether a separate password may be set now. False on a box unless staff. */
  setupAllowed?: boolean;
}

export const api = {
  config: () => request<PublicConfig>("GET", "/api/config"),
  mine: (ids: string[]) => request<{ statuses: Record<string, MyPhotoStatus> }>("GET", `/api/mine?ids=${ids.map(encodeURIComponent).join(",")}`),

  status: () => request<AuthStatus>("GET", "/api/admin/status"),
  setup: (password: string) => request<{ token: string }>("POST", "/api/admin/setup", { password }),
  login: (password: string) => request<{ token: string }>("POST", "/api/admin/login", { password }),
  logout: () => request("POST", "/api/admin/logout", {}),

  moderation: () => request<Moderation>("GET", "/api/admin/moderation"),
  approve: (id: string, pin = false) => request<{ value: StaffPhoto }>("POST", `/api/admin/photos/${id}/approve`, { pin }),
  reject: (id: string) => request("POST", `/api/admin/photos/${id}/reject`, {}),
  pin: (id: string, pinned: boolean) => request<{ value: StaffPhoto }>("POST", `/api/admin/photos/${id}/pin`, { pinned }),
  remove: (id: string) => request("DELETE", `/api/admin/photos/${id}`),
  setPaused: (paused: boolean) => request<{ paused: boolean }>("PUT", "/api/admin/paused", { paused }),
  clear: () => request<{ removed: number }>("POST", "/api/admin/clear", { confirm: "clear" }),

  state: () => request<AdminState>("GET", "/api/admin/state"),
  saveSettings: (patch: Partial<Settings>) => request<{ value: Settings }>("PUT", "/api/admin/settings", patch),
};

/**
 * A staff-only image (waiting photos aren't public) as an object URL: an <img> can't send the
 * staff token, so it's fetched here and kept until the photo leaves the list.
 */
const blobs = new Map<string, Promise<string>>();
export function staffImage(path: string): Promise<string> {
  let p = blobs.get(path);
  if (!p) {
    p = fetch(bgUrl(path), { headers: { authorization: `Bearer ${getToken()}` } }).then(async (r) => {
      if (!r.ok) throw new ApiError("Couldn't load the photo.", r.status);
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => blobs.delete(path));
    blobs.set(path, p);
  }
  return p;
}

/** Frees the object URLs of photos no longer listed. */
export function forgetStaffImages(keep: Set<string>): void {
  for (const [path, p] of blobs) {
    if (keep.has(path)) continue;
    blobs.delete(path);
    void p.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
  }
}
