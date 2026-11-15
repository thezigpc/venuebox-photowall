// Captions and first names typed by patrons. They end up on a TV in a public room, so they're
// cleaned, kept short and run through a word filter before staff even see them. The filter is
// a first line only: staff approval is what keeps the wall clean.

export const MAX_CAPTION = 80;
export const MAX_NAME = 20;

export type TextResult = { ok: true; value: string } | { ok: false; error: string };

// Words that are never OK on a bar's TV: swearing, sexual terms and slurs. Entries ending in
// "*" also match longer words starting with them ("fucking"); the others match whole words
// only, so "cocktail", "Dickens", "assistant", "Scunthorpe" and "title" stay fine.
const WORDS = [
  "fuck*", "fuk*", "fck*", "fcuk*", "motherfuck*", "phuck*", "shit*", "bullshit*", "sh1t*",
  "cunt*", "bitch*", "biatch*", "bastard*", "asshole*", "arsehole*", "ass", "asses", "arse",
  "jackass", "dumbass", "dick", "dicks", "dickhead*", "cock", "cocks", "cocksuck*", "prick",
  "pricks", "pussy", "pussies", "twat*", "wank*", "slut*", "whore*", "hoe", "hoes", "tits",
  "titties", "tit", "boobs", "boobies", "cum", "cumming", "jizz*", "dildo*", "porn", "porno*",
  "pornhub", "penis*", "vagina*", "blowjob*", "handjob*", "rape", "raped", "rapes", "raping",
  "rapist*", "nude", "nudes", "naked", "horny", "fag", "fags", "faggot*", "fagot*", "nigger*",
  "nigga*", "niga", "retard*",
  "spic", "spics", "chink", "chinks", "kike*", "tranny", "trannies", "dyke", "dykes",
  "wetback*", "coon", "coons", "gook*", "nazi*", "hitler*", "kys", "stfu",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };

const exact = new Set<string>();
const prefixes: string[] = [];
for (const w of WORDS) {
  if (w.endsWith("*")) prefixes.push(w.slice(0, -1));
  else exact.add(w);
}

/** Every letter repeated, once: "fuuck" → "fuck" (also "shiitake" → "shitake", so whole words only). */
const squashAll = (s: string) => s.replace(/(.)\1+/g, "$1");
/** Runs of three or more: "fuuuuck" → "fuck", while "shiitake" stays. */
const squashLong = (s: string) => s.replace(/(.)\1{2,}/g, "$1");
// Whole words squashed, only where squashing can't turn an ordinary word into one ("ass"
// would squash to "as", so it isn't here).
const exactSquashed = new Set([...exact].map(squashAll).filter((w) => w.length >= 4));

function wordIsBad(w: string): boolean {
  if (!w) return false;
  const long = squashLong(w);
  for (const v of w === long ? [w] : [w, long]) {
    if (exact.has(v) || prefixes.some((p) => v.startsWith(p))) return true;
  }
  // Squashing every double letter is only trusted for whole words and stems with a plain
  // ending ("fuuck", "fuucking"), never as a prefix ("shiitake" would read "shit…").
  const all = squashAll(w);
  return exactSquashed.has(all) || prefixes.some((p) => STEM_ENDINGS.some((e) => all === squashAll(p + e)));
}

const STEM_ENDINGS = ["", "s", "ed", "er", "ers", "ing", "in", "y", "head", "heads"];

/** Lowercase with accents off. */
const plain = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Look-alike digits and symbols read as letters, in chunks that have a letter in them ("sh1t", "a$$"; not "table 1"). */
const unLeet = (text: string) => text.replace(/\S+/g, (chunk) => (/[a-z]/.test(chunk) ? chunk.replace(/[0134578@$!|+]/g, (c) => LEET[c] ?? c) : chunk));

/** True when the text contains a blocked word, also spelled with symbols, repeats or s p a c e s. */
export function hasBlockedWord(text: string): boolean {
  const p = plain(text);
  const split = (s: string) => s.split(/[^a-z]+/).filter(Boolean);
  const words = split(unLeet(p));
  // Both readings: "Ass!" is "ass" as typed, even though "!" can stand for an "i".
  if (words.some(wordIsBad) || split(p).some(wordIsBad)) return true;
  // "f u c k", "f.u.c.k": runs of single letters read as one word.
  let run = "";
  for (const w of [...words, ""]) {
    if (w.length === 1) {
      run += w;
      continue;
    }
    if (run.length >= 3 && wordIsBad(run)) return true;
    run = "";
  }
  return false;
}

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|co|ly|gg|tv|me|app|xyz|info|biz|us|uk)\b)/i;
const PHONE = /(\d[\s().-]*){7,}/;

/** Control characters and the like out, runs of spaces folded into one. */
function tidy(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const length = (s: string) => [...s].length;

/** The optional caption: short, friendly, no links or phone numbers. Empty is fine. */
export function cleanCaption(input: unknown): TextResult {
  if (input === undefined || input === null) return { ok: true, value: "" };
  if (typeof input !== "string") return { ok: false, error: "The caption must be text." };
  const value = tidy(input);
  if (length(value) > MAX_CAPTION) return { ok: false, error: `Keep the caption to ${MAX_CAPTION} characters.` };
  if (hasBlockedWord(value)) return { ok: false, error: "Please keep the caption friendly: it goes up on the TVs." };
  if (LINK.test(value)) return { ok: false, error: "Captions can't have links in them." };
  if (PHONE.test(value)) return { ok: false, error: "Captions can't have phone numbers in them." };
  return { ok: true, value };
}

/** The optional first name: letters (any language), apostrophes and hyphens; one word. */
export function cleanName(input: unknown): TextResult {
  if (input === undefined || input === null) return { ok: true, value: "" };
  if (typeof input !== "string") return { ok: false, error: "The name must be text." };
  const first = tidy(input).split(" ")[0] ?? "";
  const value = first.replace(/[^\p{L}\p{M}'’-]/gu, "").replace(/^['’-]+|['’-]+$/g, "");
  if (first && !value) return { ok: false, error: "Use letters for your first name." };
  if (length(value) > MAX_NAME) return { ok: false, error: `Just your first name, please (up to ${MAX_NAME} letters).` };
  if (hasBlockedWord(value)) return { ok: false, error: "Please use your real first name." };
  return { ok: true, value };
}
