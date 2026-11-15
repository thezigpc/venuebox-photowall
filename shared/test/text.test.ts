import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanCaption, cleanName, hasBlockedWord, MAX_CAPTION } from "../src/index.js";

describe("word filter", () => {
  test("blocks swearing, also disguised", () => {
    for (const t of ["what the fuck", "FUCKING great", "sh1t", "a$$", "Ass!", "f u c k this", "f.u.c.k", "fuuuuck", "fuuck", "bullshit night", "Fück"]) {
      assert.equal(hasBlockedWord(t), true, t);
    }
  });

  test("leaves ordinary words alone", () => {
    for (const t of [
      "Cocktail hour!",
      "Reading Dickens",
      "Scunthorpe United",
      "my assistant",
      "Title match",
      "Negroni time",
      "Pornstar martini",
      "Shiitake tacos",
      "Table 1 rocks",
      "Happy 30th Sam!!!",
      "Class of 2026",
      "hell yeah",
    ]) {
      assert.equal(hasBlockedWord(t), false, t);
    }
  });
});

describe("captions", () => {
  test("tidy and optional", () => {
    assert.deepEqual(cleanCaption(undefined), { ok: true, value: "" });
    assert.deepEqual(cleanCaption("  Happy\n\n birthday\tJo  "), { ok: true, value: "Happy birthday Jo" });
    assert.deepEqual(cleanCaption("a‮b"), { ok: true, value: "a b" });
  });

  test("length counts characters, emoji included", () => {
    assert.equal(cleanCaption("x".repeat(MAX_CAPTION)).ok, true);
    assert.equal(cleanCaption("x".repeat(MAX_CAPTION + 1)).ok, false);
    assert.equal(cleanCaption("🎉".repeat(MAX_CAPTION)).ok, true);
  });

  test("no swearing, links or phone numbers", () => {
    assert.equal(cleanCaption("this is shit").ok, false);
    assert.equal(cleanCaption("visit www.example.com").ok, false);
    assert.equal(cleanCaption("follow mysite.com").ok, false);
    assert.equal(cleanCaption("https://x.y").ok, false);
    assert.equal(cleanCaption("call 555-123-4567").ok, false);
    assert.equal(cleanCaption("Happy 21st!").ok, true);
    assert.equal(cleanCaption(42).ok, false);
  });
});

describe("first names", () => {
  test("one word of letters", () => {
    assert.deepEqual(cleanName(" Sam Smith "), { ok: true, value: "Sam" });
    assert.deepEqual(cleanName("José"), { ok: true, value: "José" });
    assert.deepEqual(cleanName("O'Neil"), { ok: true, value: "O'Neil" });
    assert.deepEqual(cleanName("Mary-Kate"), { ok: true, value: "Mary-Kate" });
    assert.deepEqual(cleanName("<b>Al</b>"), { ok: true, value: "bAlb" });
    assert.deepEqual(cleanName(""), { ok: true, value: "" });
  });

  test("refuses junk, long names and swearing", () => {
    assert.equal(cleanName("1234").ok, false);
    assert.equal(cleanName("A".repeat(21)).ok, false);
    assert.equal(cleanName("Dick").ok, false);
  });
});
