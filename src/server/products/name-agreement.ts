/**
 * "Съмнителни връзки" (owner report 2026-11-03): SKUs get reused — an old product's SKU later belongs to a
 * different perfume, so a link made by SKU (the only key, by design) can join two different products. This module
 * scores how well the two NAMES of a link agree. It is a HINT for people and a safety brake (the Shopify stock push
 * skips a flagged link, an order gets a soft finding) — it never links, unlinks or blocks by itself.
 *
 * Pure: no database. Names are normalised (accents, case, punctuation, Shopify's "Default Title", Cyrillic
 * transliterated to Latin and a few spelling folds), then split into signals:
 *   - volumes in ml / oz / g (a different volume is a different product: 15 ml vs 100 ml always flags);
 *   - concentration (EDP / EDT / EDC / parfum-extrait — both named and different flags);
 *   - flanker words (Intense, Elixir, Noir, Limited, …): one side has one the other lacks → another product
 *     of the same family (the most likely SKU reuse: an old SKU now on the flanker);
 *   - gender (men vs women, both named and different);
 *   - numbers other than volumes ("… 2" vs "… 3", or present on one side only);
 *   - the core words, without noise words (decant, tester, eau, de, …), the master's brand and the SKU.
 * Core words are compared word by word (typos tolerated) with optional weights: a word many masters share
 * (a brand, "noir") counts less than a word that names this product. A weighted Dice below the threshold flags,
 * and so does a substitution: each side has a heavy word the other lacks ("Alpha Bloom" vs "Beta Bloom").
 * Extra words on ONE side only (a brand in the store title) are tolerated — unless they are flanker words.
 */

export type DisagreementReason = "volume" | "concentration" | "flanker" | "gender" | "number" | "name";

export interface NameAgreement {
  /** 0..1; null = the names carry no usable signal (e.g. one side is only a SKU or "Default Title"). */
  score: number | null;
  flagged: boolean;
  reasons: DisagreementReason[];
  volumes: { a: number[]; b: number[] };
}

/** Below this the names are considered to name different products. Tuned on the cases in the tests. */
export const AGREEMENT_THRESHOLD = 0.55;
/** A volume / concentration / flanker / gender / number mismatch caps the score here (always below the threshold). */
const MISMATCH_CAP = 0.25;

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sht",
  ъ: "a",
  ь: "i",
  ю: "iu",
  я: "ia",
  ы: "i",
  э: "e",
  ё: "e",
  є: "e",
  і: "i",
  ї: "i",
};

/**
 * Words that describe the form of a product, not which product it is (both scripts, after transliteration).
 * Gender words are noise for the core words but read first as their own signal (genderOf).
 */
const NOISE = new Set(
  [
    "decant",
    "decants",
    "dekant",
    "tester",
    "testers",
    "sample",
    "samples",
    "otlivka",
    "mostra",
    "probnik",
    "mini",
    "travel",
    "spray",
    "vapo",
    "vaporisateur",
    "natural",
    "perfume",
    "parfume",
    "parfium",
    "parfiumna",
    "parfum",
    "aromat",
    "aroma",
    "fragrance",
    "eau",
    "de",
    "du",
    "la",
    "le",
    "l",
    "the",
    "and",
    "of",
    "for",
    "pour",
    "women",
    "woman",
    "men",
    "man",
    "her",
    "him",
    "homme",
    "femme",
    "unisex",
    "uniseks",
    "za",
    "zheni",
    "mazhe",
    "damski",
    "mazhki",
    "voda",
    "toaletna",
    "default",
    "title",
    "ml",
    "edp",
    "edt",
    "edc",
    "extrait",
    "i",
    "s",
    "v",
  ].map(fold),
);

/** Lower-case, accents removed, Cyrillic transliterated, punctuation → spaces, spaces collapsed. */
export function basicNormalise(s: string) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+-\s+default title\s*$/i, "")
    .replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC[ch] ?? "")
    .replace(/[^\p{L}\p{N}.,]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spelling folds applied to one word (both sides alike): "Alpha"/"Алфа" → "alfa", "Bloom"/"Блум" → "blum". */
function fold(w: string) {
  return w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/w/g, "v")
    .replace(/x/g, "ks")
    .replace(/y/g, "i")
    .replace(/oo|ou/g, "u")
    .replace(/ee/g, "i")
    .replace(/(.)\1+/g, "$1");
}

const VOLUME_RE = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|oz|ml|мл|gr|g|гр|г)(?![\p{L}])/giu;

/** An oz size in ml, rounded to the size it is sold as (1.7 oz → 50, 3.4 oz → 100, 0.33 oz → 10). */
const ozToMl = (oz: number) => {
  const ml = oz * 29.5735;
  return ml < 10 ? Math.round(ml * 2) / 2 : Math.round(ml / 5) * 5;
};

/** Volumes (ml, oz converted to ml) and weights (g, the size of a solid / cream) — one list of sizes. */
function volumesOf(raw: string): { volumes: number[]; rest: string } {
  const volumes: number[] = [];
  const rest = raw.normalize("NFKD").replace(VOLUME_RE, (_m, n: string, unit: string) => {
    let v = Number(n.replace(",", "."));
    if (/oz/i.test(unit)) v = ozToMl(v);
    if (Number.isFinite(v) && v > 0) volumes.push(v);
    return " ";
  });
  return { volumes: [...new Set(volumes)].sort((a, b) => a - b), rest };
}

const CONCENTRATIONS: [string, RegExp][] = [
  ["edp", / (?:edp|eau de parfum|parfiumna voda) /g],
  ["edt", / (?:edt|eau de toilette|toaletna voda) /g],
  ["edc", / (?:edc|eau de cologne|odekolon) /g],
  // Parfum / extrait is its own concentration (not EDP). The Bulgarian "парфюм" is the generic word: noise.
  ["parfum", / (?:extrait(?: de parfum)?|ekstrakt|(?:le )?parfum) /g],
];

function concentrationsOf(text: string): { found: Set<string>; rest: string } {
  const found = new Set<string>();
  let rest = ` ${text} `;
  for (const [key, re] of CONCENTRATIONS) {
    // Twice: adjacent matches share the separating space.
    for (let k = 0; k < 2; k++)
      rest = rest.replace(re, () => {
        found.add(key);
        return "  ";
      });
  }
  return { found, rest: rest.replace(/\s+/g, " ").trim() };
}

/** Flanker words (normalised, before folds) → one key; spelling variants share a key. */
const FLANKERS = new Map<string, string>(
  (
    [
      ["intense", ["intense", "intens", "intenso", "intensa", "intenz", "intenzivna"]],
      ["elixir", ["elixir", "eliksir"]],
      ["extreme", ["extreme", "extrem", "ekstrim"]],
      ["absolu", ["absolu", "absolue", "absolute"]],
      ["sport", ["sport", "sports"]],
      ["noir", ["noir", "noire"]],
      ["black", ["black"]],
      ["night", ["night", "nuit", "midnight", "notte"]],
      ["profondo", ["profondo", "profonde"]],
      ["profumo", ["profumo"]],
      ["limited", ["limited"]],
      ["edition", ["edition"]],
      ["collector", ["collector", "collectors"]],
      ["prive", ["prive", "privee"]],
      ["oud", ["oud"]],
      ["very", ["very"]],
      ["fresh", ["fresh", "fraiche", "frais"]],
      ["summer", ["summer"]],
      ["legere", ["legere"]],
      ["pure", ["pure"]],
      ["royal", ["royal", "royale"]],
      ["supreme", ["supreme"]],
      ["platinum", ["platinum", "platine"]],
      ["gold", ["gold"]],
      ["rouge", ["rouge", "red"]],
      ["blanc", ["blanc", "blanche", "white"]],
      ["essence", ["essence"]],
      ["signature", ["signature"]],
    ] as [string, string[]][]
  ).flatMap(([key, words]) => words.map((w) => [w, key] as [string, string])),
);

/** Gender words (normalised, before folds) → m / f. Unisex is compatible with both: not a signal. */
const GENDER = new Map<string, "m" | "f">([
  ...["men", "man", "him", "homme", "uomo", "hombre", "mazhe", "mazhki", "mazhka", "mazh"].map(
    (w) => [w, "m"] as [string, "m"],
  ),
  ...[
    "women",
    "woman",
    "her",
    "femme",
    "donna",
    "mujer",
    "zheni",
    "zhenski",
    "zhenska",
    "damski",
    "damska",
  ].map((w) => [w, "f"] as [string, "f"]),
]);

const NUMBER_RE = /^\d+(?:[.,]\d+)?$/;

export interface NameParts {
  words: string[];
  volumes: number[];
  concentrations: Set<string>;
  flankers: Set<string>;
  genders: Set<"m" | "f">;
  /** Numbers other than SKUs and volumes with a unit (a bare "100" may still be the other side's 100 ml). */
  numbers: Set<string>;
}

/** Splits one name into its signals; `drop` = brand and SKU, removed from the core words. */
export function nameParts(
  raw: string,
  drop: { brand?: string | null; skus?: (string | null)[] } = {},
): NameParts {
  const { volumes, rest } = volumesOf(raw);
  const text = basicNormalise(rest).replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const { found, rest: core } = concentrationsOf(text);
  const brandWords = new Set(
    drop.brand ? basicNormalise(drop.brand).replace(/[.,]/g, " ").split(" ").filter(Boolean).map(fold) : [],
  );
  const skuKeys = new Set(
    (drop.skus ?? [])
      .filter((s): s is string => !!s && !!s.trim())
      .map((s) => basicNormalise(s).replace(/[^a-z0-9]/g, "")),
  );
  const tokens = core.split(" ").filter(Boolean);
  const none = { flankers: new Set<string>(), genders: new Set<"m" | "f">(), numbers: new Set<string>() };
  // The whole name is only the SKU (Shopify titles are sometimes just the code): no name at all.
  if (skuKeys.has(tokens.join(""))) return { words: [], volumes, concentrations: found, ...none };
  const kept = tokens.filter((t) => !skuKeys.has(t) && !brandWords.has(fold(t)));
  const flankers = new Set(kept.map((t) => FLANKERS.get(t)).filter((k): k is string => !!k));
  const genders = new Set(kept.map((t) => GENDER.get(t)).filter((k): k is "m" | "f" => !!k));
  const numbers = new Set(kept.filter((t) => NUMBER_RE.test(t)).map((t) => String(Number(t))));
  const words = kept
    .map(fold)
    .filter((t) => t.length > 1 || /\d/.test(t))
    .filter((t) => !NOISE.has(t) && !brandWords.has(t));
  return { words, volumes, concentrations: found, flankers, genders, numbers };
}

function bigrams(s: string) {
  const out = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(x: string, y: string) {
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

/** Similarity of two words: exact, or a typo (long enough words, Dice of bigrams ≥ 0.5); digits must be exact. */
function wordSim(a: string, b: string) {
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return 0;
  if (Math.min(a.length, b.length) < 4) return 0;
  const d = dice(a, b);
  return d >= 0.5 ? d : 0;
}

export type WordWeight = (word: string) => number;

/** Words weighing at least this count as naming the product (a brand-like word shared by masters weighs less). */
const HEAVY = 0.5;

/**
 * Agreement of the core words: a weighted Dice (both names alike), and whether the names SUBSTITUTE a word —
 * each side has a heavy word the other lacks ("Maison Lumen Alpha Bloom" vs "Maison Lumen Beta Bloom").
 * Extra words on one side only ("Alpha Bloom" vs "Maison Lumen Alpha Bloom") are not a substitution.
 */
export function wordAgreement(
  a: string[],
  b: string[],
  weight: WordWeight = () => 1,
): { score: number; substitution: boolean } | null {
  if (!a.length || !b.length) return null;
  if (a.join("") === b.join("")) return { score: 1, substitution: false };
  const wa = a.map(weight);
  const wb = b.map(weight);
  const pairs: { i: number; j: number; s: number }[] = [];
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const s = wordSim(x, y);
      if (s > 0) pairs.push({ i, j, s });
    }),
  );
  pairs.sort((p, q) => q.s - p.s);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let matched = 0;
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    matched += p.s * ((wa[p.i]! + wb[p.j]!) / 2);
  }
  const WA = wa.reduce((x, y) => x + y, 0);
  const WB = wb.reduce((x, y) => x + y, 0);
  // Numbers are their own signal ("… 2" vs "… 3" is reported as a number, not as other words).
  const heavyLeft = (words: string[], w: number[], used: Set<number>) =>
    w.some((x, i) => !used.has(i) && x >= HEAVY && !/^\d+$/.test(words[i]!));
  return {
    score: Math.min(1, (2 * matched) / (WA + WB)),
    substitution: heavyLeft(a, wa, usedA) && heavyLeft(b, wb, usedB),
  };
}

const disjoint = <T>(a: Iterable<T>, b: Set<T>) => {
  for (const x of a) if (b.has(x)) return false;
  return true;
};
const sameSet = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * How well the item's name (warehouse product / store variant) agrees with the master product's name.
 * `brand`: the master's brand (removed from both); `skus`: codes to ignore when a name repeats them;
 * `weight`: a weight per core word (see wordWeights) — 1 for every word when not given.
 */
export function nameAgreement(
  itemName: string,
  masterName: string,
  opts: { brand?: string | null; skus?: (string | null)[]; weight?: WordWeight } = {},
): NameAgreement {
  const A = nameParts(itemName, opts);
  const B = nameParts(masterName, opts);
  const reasons: DisagreementReason[] = [];
  if (A.volumes.length && B.volumes.length && disjoint(A.volumes, new Set(B.volumes))) reasons.push("volume");
  if (A.concentrations.size && B.concentrations.size && disjoint(A.concentrations, B.concentrations))
    reasons.push("concentration");
  const words = wordAgreement(A.words, B.words, opts.weight);
  let score = words?.score ?? null;
  // Different core words: "name" (the flanker / gender / number signals only refine names that otherwise agree).
  if (words && (words.score < AGREEMENT_THRESHOLD || words.substitution)) {
    if (!reasons.length) reasons.push("name");
    score = Math.min(words.score, MISMATCH_CAP);
  } else if (words) {
    // The other signals need a name on both sides (a SKU-only title carries none).
    if (!sameSet(A.flankers, B.flankers)) reasons.push("flanker");
    if (A.genders.size && B.genders.size && disjoint(A.genders, B.genders)) reasons.push("gender");
    const sizes = new Set([...A.volumes, ...B.volumes].map(String));
    const nums = (p: NameParts) => new Set([...p.numbers].filter((n) => !sizes.has(n)));
    if (!sameSet(nums(A), nums(B))) reasons.push("number");
  }
  if (reasons.length) score = Math.min(score ?? MISMATCH_CAP, MISMATCH_CAP);
  const rounded = score === null ? null : Math.round(score * 100) / 100;
  return {
    score: rounded,
    flagged: rounded !== null && rounded < AGREEMENT_THRESHOLD,
    reasons,
    volumes: { a: A.volumes, b: B.volumes },
  };
}

/**
 * Word weights from the account's master names: a word in many names (a brand, a common word) counts less,
 * 1 / (1 + ln(document frequency)). Words not seen weigh 1.
 */
export function wordWeights(masterNames: { name: string; brand?: string | null }[]): WordWeight {
  const df = new Map<string, number>();
  for (const m of masterNames) {
    for (const w of new Set(nameParts(m.name).words)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  return (w) => {
    const n = df.get(w) ?? 1;
    return 1 / (1 + Math.log(Math.max(1, n)));
  };
}

/** What a confirmation covers: the product and both names as normalised — any name change voids it. */
export function linkNameKey(productId: string, itemName: string, masterName: string) {
  return [productId, basicNormalise(itemName), basicNormalise(masterName)].join("\u0001");
}
