// The app's single connection to a Bar Games box (see BARGAMES.md).
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op: that's
// guaranteed by the SDK. An app has no rooms; what the box gets from the photo wall is:
//   - x-photowall-approved, when staff put a photo on the wall (scenes can flash the lights);
//   - an attention item on the box's Tonight page while photos wait for approval.

import { createBarGames, type BarGames } from "@bargames/sdk/server";
import { log } from "@bargames/gamekit/server";

export const APPROVED_EVENT = "x-photowall-approved";

export function makeBarGames(opts: { coreUrl?: string; token?: string; defaultName: string }): BarGames {
  const bg = createBarGames({ gameId: "photowall", defaultName: opts.defaultName, coreUrl: opts.coreUrl, token: opts.token });
  bg.setStatusProvider(() => ({ rooms: [] }));
  return bg;
}

/** The venue's name for the app on a box; null standalone or when the box can't be reached. */
export async function venueName(bg: BarGames): Promise<string | null> {
  if (!bg.connected) return null;
  try {
    return (await bg.venue()).game.displayName || null;
  } catch (err) {
    log.warn("bargames", "venue context unavailable", { err: String(err) });
    return null;
  }
}

/**
 * "3 photos waiting for approval" on the box's Tonight page, with an Open link to the queue.
 * Sent only when the count changes, a moment after the last change (approving ten photos in a
 * row sends one update, not ten).
 */
export function attentionReporter(bg: BarGames, delayMs = 1500): (pending: number, paused: boolean) => void {
  let sent = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (pending, paused) => {
    if (!bg.connected) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const items = pending > 0
        ? [{ level: "info" as const, message: `${pending} photo${pending === 1 ? "" : "s"} waiting for approval`, actionPath: "/host" }]
        : [];
      if (paused) items.push({ level: "info", message: "Photo uploads are paused", actionPath: "/host" });
      const key = JSON.stringify(items);
      if (key === sent) return;
      sent = key;
      void bg.setAttention(items).catch((err: unknown) => {
        sent = "";
        log.warn("bargames", "attention update failed", { err: String(err) });
      });
    }, delayMs);
    timer.unref?.();
  };
}
