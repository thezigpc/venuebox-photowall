import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildCycle, initialRotation, nextPhoto, type RotationPhoto, type RotationState } from "../src/index.js";

const photo = (id: string, approvedAt: string, pinned = false): RotationPhoto => ({ id, approvedAt, pinned });

/** A repeatable random source. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function run(photos: RotationPhoto[], n: number, weight = 3, state: RotationState = initialRotation(), rand = seeded()) {
  const shown: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = nextPhoto(state, photos, weight, rand);
    state = r.state;
    if (r.id) shown.push(r.id);
  }
  return { shown, state };
}

describe("rotation", () => {
  test("empty wall: nothing", () => {
    assert.equal(nextPhoto(initialRotation(), [], 3).id, null);
  });

  test("new photos go up first, newest first", () => {
    const photos = [photo("a", "2026-11-14T20:00:00Z"), photo("b", "2026-11-14T21:00:00Z"), photo("c", "2026-11-14T22:00:00Z")];
    const { shown, state } = run(photos, 3);
    assert.deepEqual(shown, ["c", "b", "a"]);
    // A photo approved now jumps the queue.
    const more = [...photos, photo("d", "2026-11-14T23:00:00Z")];
    assert.equal(nextPhoto(state, more, 3).id, "d");
  });

  test("every photo comes round, pinned ones more often, never twice in a row", () => {
    const photos = [
      photo("a", "2026-11-14T20:00:00Z", true),
      photo("b", "2026-11-14T20:01:00Z"),
      photo("c", "2026-11-14T20:02:00Z"),
      photo("d", "2026-11-14T20:03:00Z"),
      photo("e", "2026-11-14T20:04:00Z"),
    ];
    const { shown } = run(photos, 5 + 7 * 20, 3);
    const counts = new Map<string, number>();
    for (const id of shown) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of ["b", "c", "d", "e"]) assert.ok((counts.get(id) ?? 0) >= 20, id);
    assert.ok(counts.get("a")! >= 2.5 * counts.get("b")!, `pinned ${counts.get("a")} vs ${counts.get("b")}`);
    for (let i = 1; i < shown.length; i++) assert.notEqual(shown[i], shown[i - 1], `repeat at ${i}`);
  });

  test("removed photos drop out at once", () => {
    const photos = [photo("a", "2026-11-14T20:00:00Z"), photo("b", "2026-11-14T20:01:00Z"), photo("c", "2026-11-14T20:02:00Z")];
    const { state } = run(photos, 4);
    const left = photos.filter((p) => p.id !== "a");
    const { shown } = run(left, 10, 3, state);
    assert.ok(!shown.includes("a"));
  });

  test("a single photo stays up", () => {
    const { shown } = run([photo("a", "2026-11-14T20:00:00Z", true)], 4);
    assert.deepEqual(shown, ["a", "a", "a", "a"]);
  });

  test("a cycle spreads a pinned photo's copies apart", () => {
    const photos = [photo("p", "x", true), photo("a", "x"), photo("b", "x"), photo("c", "x")];
    for (let seed = 1; seed < 50; seed++) {
      const cycle = buildCycle(photos, 3, seeded(seed));
      assert.equal(cycle.filter((id) => id === "p").length, 3);
      assert.equal(cycle.length, 6);
      for (let i = 1; i < cycle.length; i++) assert.notEqual(cycle[i], cycle[i - 1], `seed ${seed}: ${cycle}`);
    }
  });
});
