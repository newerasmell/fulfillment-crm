/**
 * "Съмнителни връзки" (owner report 2026-11-03): SKUs get reused — an old product's SKU later belongs to a
 * different perfume, so a link made by SKU (the only key, by design) can join two different products. This module
 * scores how well the two NAMES of a link agree. It is a HINT for people and a safety brake (the Shopify stock push
 * skips a flagged link, an order gets a soft finding) — it never links, unlinks or blocks by itself.
 *
 * Pure: no database. Names are normalised (accents, case, punctuation, Shopify's "Default Title", Cyrillic
 * transliterated to Latin and a few spelling folds), then split into three signals:
 *   - volumes in ml (a different volume is a different product: 15 ml vs 100 ml always flags);
 *   - concentration (EDP / EDT / EDC / extrait — both named and different flags);
 *   - the core words, without noise words (decant, tester, eau, de, …), the master's brand and the SKU.
 * Core words are compared word by word (typos tolerated) with optional weights: a word many masters share
 * (a brand, "noir") counts less than a word that names this product.
 */

export type DisagreementReason = "volume" | "concentration" | "name";

export interface NameAgreement {
  /** 0..1; null = the names carry no usable signal (e.g. one side is only a SKU or "Default Title"). */
  score: number | null;
  flagged: boolean;
  reasons: DisagreementReason[];
  volumes: { a: number[]; b: number[] };
}

/** Below this the names are considered to name different products. Tuned on the cases in the tests. */
export const AGREEMENT_THRESHOLD = 0.55;
/** A volume or concentration mismatch caps the score here (always below the threshold). */
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

/** Words that describe the form of a product, not which product it is (both scripts, after transliteration). */
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

const VOLUME_RE = /(\d+(?:[.,]\d+)?)\s*(?:ml|мл)(?![\p{L}])/giu;

function volumesOf(raw: string): { volumes: number[]; rest: string } {
  const volumes: number[] = [];
  const rest = raw.normalize("NFKD").replace(VOLUME_RE, (_m, n: string) => {
    const v = Number(n.replace(",", "."));
    if (Number.isFinite(v) && v > 0) volumes.push(v);
    return " ";
  });
  return { volumes: [...new Set(volumes)].sort((a, b) => a - b), rest };
}

const CONCENTRATIONS: [string, RegExp][] = [
  ["extrait", / (?:extrait(?: de parfum)?|ekstrakt) /g],
  ["edp", / (?:edp|eau de parfum|parfiumna voda) /g],
  ["edt", / (?:edt|eau de toilette|toaletna voda) /g],
  ["edc", / (?:edc|eau de cologne|odekolon) /g],
];

function concentrationsOf(text: string): { found: Set<string>; rest: string } {
  const found = new Set<string>();
  let rest = ` ${text} `;
  for (const [key, re] of CONCENTRATIONS) {
    rest = rest.replace(re, () => {
      found.add(key);
      return " ";
    });
  }
  return { found, rest: rest.trim() };
}

export interface NameParts {
  words: string[];
  volumes: number[];
  concentrations: Set<string>;
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
  // The whole name is only the SKU (Shopify titles are sometimes just the code): no name at all.
  if (skuKeys.has(tokens.join(""))) return { words: [], volumes, concentrations: found };
  const words = tokens
    .filter((t) => !skuKeys.has(t))
    .map(fold)
    .filter((t) => t.length > 1 || /\d/.test(t))
    .filter((t) => !NOISE.has(t) && !brandWords.has(t));
  return { words, volumes, concentrations: found };
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

/**
 * Agreement of the core words: the mean of a weighted Dice (both names alike) and a weighted overlap (the shorter
 * name is contained in the longer one) — so "Alpha Bloom" vs "Maison Lumen Alpha Bloom" agrees, while two
 * different perfumes sharing only a brand word do not.
 */
export function wordAgreement(a: string[], b: string[], weight: WordWeight = () => 1) {
  if (!a.length || !b.length) return null;
  if (a.join("") === b.join("")) return 1;
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
  const diceScore = (2 * matched) / (WA + WB);
  const overlap = matched / Math.min(WA, WB);
  return Math.min(1, (diceScore + Math.min(1, overlap)) / 2);
}

const disjoint = <T>(a: Iterable<T>, b: Set<T>) => {
  for (const x of a) if (b.has(x)) return false;
  return true;
};

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
  let score = words;
  if (reasons.length) score = Math.min(score ?? MISMATCH_CAP, MISMATCH_CAP);
  if (score !== null && score < AGREEMENT_THRESHOLD && !reasons.length) reasons.push("name");
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
