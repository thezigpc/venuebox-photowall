import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, mergeSettings, settingsFromStored } from "../src/index.js";

test("defaults: 7 days, 5 per hour", () => {
  assert.equal(DEFAULT_SETTINGS.retentionDays, 7);
  assert.equal(DEFAULT_SETTINGS.uploadsPerHour, 5);
  assert.equal(DEFAULT_SETTINGS.paused, false);
});

test("patches are checked", () => {
  const r = mergeSettings(DEFAULT_SETTINGS, { retentionDays: 3, showNames: false, name: "  Kava  Bar " });
  assert.ok(r.ok);
  assert.equal(r.value.retentionDays, 3);
  assert.equal(r.value.showNames, false);
  assert.equal(r.value.name, "Kava Bar");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { retentionDays: 0 }).ok, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { retentionDays: 31 }).ok, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { uploadsPerHour: 2.5 }).ok, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { paused: "yes" }).ok, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, null).ok, false);
});

test("a damaged file falls back field by field", () => {
  const s = settingsFromStored({ retentionDays: 99, slideSeconds: 12, extra: 1, paused: true });
  assert.equal(s.retentionDays, 7);
  assert.equal(s.slideSeconds, 12);
  assert.equal(s.paused, true);
  assert.deepEqual(settingsFromStored("nonsense"), DEFAULT_SETTINGS);
});
