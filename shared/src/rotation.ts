// What the TV shows next. Pure, so it's tested without a browser.
//
// - A photo the TV hasn't shown yet goes up next, newest first: a patron whose photo was just
//   approved sees it on the TV within one slide.
// - Then the wall cycles through every approved photo in a shuffled order, with each pinned
//   photo coming round `pinnedWeight` times per cycle, spread out evenly.
// - Never the same photo twice in a row while there are others.

export interface RotationPhoto {
  id: string;
  pinned: boolean;
  approvedAt: string;
}

export interface RotationState {
  /** What's left of the current cycle. */
  queue: string[];
  /** Photos this TV has shown at least once. */
  seen: string[];
  /** The photo on screen now. */
  last: string | null;
}

export const initialRotation = (): RotationState => ({ queue: [], seen: [], last: null });

/** One cycle: each photo once, pinned ones `weight` times, copies spread across the cycle. */
export function buildCycle(photos: RotationPhoto[], weight: number, rand: () => number = Math.random): string[] {
  const copies = Math.max(1, Math.round(weight));
  const shuffle = <T>(list: T[]): T[] => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const pinned = shuffle(photos.filter((p) => p.pinned));
  const others = shuffle(photos.filter((p) => !p.pinned));
  const length = others.length + pinned.length * copies;
  const cells: (string | null)[] = new Array(length).fill(null);
  // Each pinned photo's copies go length/copies apart (from a random start); a taken cell moves
  // a copy on to the next free one. The other photos fill the gaps in shuffled order.
  const gap = length / copies;
  for (const p of pinned) {
    const start = rand() * gap;
    for (let k = 0; k < copies; k++) {
      let pos = Math.floor(start + k * gap) % length;
      while (cells[pos] !== null) pos = (pos + 1) % length;
      cells[pos] = p.id;
    }
  }
  let next = 0;
  for (let i = 0; i < length; i++) if (cells[i] === null) cells[i] = others[next++].id;
  // Collisions can still put two copies side by side: skip ahead past the photo just placed.
  // Only unavoidable repeats remain (one pinned photo and hardly any others).
  const left = cells as string[];
  const out: string[] = [];
  while (left.length) {
    const k = left.findIndex((id) => id !== out[out.length - 1]);
    out.push(...left.splice(k < 0 ? 0 : k, 1));
  }
  return out;
}

export function nextPhoto(
  state: RotationState,
  photos: RotationPhoto[],
  pinnedWeight: number,
  rand: () => number = Math.random,
): { id: string | null; state: RotationState } {
  if (photos.length === 0) return { id: null, state: { queue: [], seen: [], last: null } };
  const ids = new Set(photos.map((p) => p.id));
  const seen = state.seen.filter((id) => ids.has(id));
  let queue = state.queue.filter((id) => ids.has(id));
  const last = state.last && ids.has(state.last) ? state.last : null;

  const seenSet = new Set(seen);
  const fresh = photos.filter((p) => !seenSet.has(p.id)).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));
  if (fresh.length > 0) {
    const id = fresh[0].id;
    return { id, state: { queue: queue.filter((q) => q !== id), seen: [...seen, id], last: id } };
  }

  if (photos.length === 1) return { id: photos[0].id, state: { queue: [], seen, last: photos[0].id } };

  if (queue.length === 0) queue = buildCycle(photos, pinnedWeight, rand);
  // Don't repeat what's on screen at the seam between two cycles.
  if (queue[0] === last) {
    const k = queue.findIndex((id) => id !== last);
    if (k > 0) [queue[0], queue[k]] = [queue[k], queue[0]];
  }
  const [id, ...rest] = queue;
  return { id, state: { queue: rest, seen, last: id } };
}
