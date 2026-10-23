/**
 * Room Assistant text retrieval: shopper vocabulary normalisation and a small field-weighted BM25 index.
 * Pure functions only, so catalogue and policy search can be tested without Shopify or a model.
 *
 * Synonym groups are applied identically to documents and queries, so "couch" and "sofa" become one token.
 * Related groups only widen a query (at reduced weight): "grey" also looks at "charcoal", never the reverse.
 */

/** Equivalent phrases, canonical form first. Longer phrases are replaced before shorter ones. */
const EQUIVALENT: string[][] = [
  // Bed sizes. UK "small double" must not be read as "small" + "double".
  ["smalldouble", "small double", "4ft bed", "4ft double"],
  ["superking", "super king", "super king size", "superking size", "california king", "cal king"],
  ["king", "king size", "kingsize"],
  ["double", "full size", "full size bed"],
  ["single", "twin size", "twin"],
  ["queen", "queen size"],
  // Furniture.
  ["sofa", "couch", "settee", "loveseat", "love seat", "chesterfield"],
  ["cornersofa", "corner sofa", "sectional", "l shaped sofa", "l shape sofa", "corner couch"],
  ["sofabed", "sofa bed", "sleeper sofa", "futon"],
  ["bed", "bed frame", "bedframe", "bedstead", "divan"],
  ["ottomanbed", "ottoman bed", "storage bed", "lift up bed"],
  ["armchair", "accent chair", "lounge chair", "club chair", "tub chair", "wingback chair", "wing chair"],
  ["footstool", "ottoman", "pouffe", "pouf", "footrest"],
  ["bedside", "bedside table", "nightstand", "night stand", "bedside cabinet"],
  ["wardrobe", "closet", "armoire"],
  ["drawers", "chest of drawers", "dresser", "tallboy"],
  ["diningtable", "dining table", "kitchen table"],
  ["coffeetable", "coffee table", "cocktail table"],
  ["headboard", "head board"],
  ["rug", "carpet", "runner"],
  // Colours.
  ["grey", "gray"],
  ["cream", "ivory", "off white", "offwhite", "ecru"],
  ["navy", "navy blue", "dark blue", "midnight blue"],
  ["beige", "sand", "taupe"],
  ["colour", "color"],
  // Materials.
  ["boucle", "bouclé", "teddy", "teddy boucle"],
  ["velvet", "plush velvet", "crushed velvet"],
  ["leather", "faux leather", "pu leather", "vegan leather", "leatherette"],
  ["oak", "solid oak", "oak wood"],
  ["linen", "linen look", "linen effect"],
  // Space.
  ["compact", "small space", "small room", "space saving", "small spaces", "apartment", "studio flat", "narrow"],
];

/** One-way query widening: canonical token -> related canonical tokens. */
const RELATED: Record<string, string[]> = {
  grey: ["charcoal", "silver", "slate", "stone", "dove", "graphite"],
  cream: ["oatmeal", "natural", "beige", "white", "mink"],
  beige: ["cream", "oatmeal", "natural", "mink"],
  navy: ["blue"],
  blue: ["navy", "teal"],
  green: ["sage", "olive", "emerald", "forest"],
  pink: ["blush", "rose", "dusky"],
  brown: ["chocolate", "mocha", "walnut", "tan"],
  bed: ["headboard", "ottomanbed"],
  ottomanbed: ["bed"],
  sofa: ["cornersofa", "sofabed"],
  cornersofa: ["sofa"],
  sofabed: ["sofa"],
  armchair: ["chair"],
  chair: ["armchair"],
  compact: ["single", "smalldouble", "small", "loveseat"],
  bedroom: ["bed", "bedside", "wardrobe", "drawers"],
  living: ["sofa", "armchair", "coffeetable"],
  dining: ["diningtable", "chair"],
};

/** Compound canonical tokens also index their base noun, so "table" still finds coffee tables. */
const COMPONENTS: Record<string, string[]> = {
  cornersofa: ["sofa"], sofabed: ["sofa", "bed"], ottomanbed: ["bed"], diningtable: ["table"],
  coffeetable: ["table"], bedside: ["table"], smalldouble: ["double"], superking: ["king"],
};

/** Furniture nouns. A query naming one must match it, so "green sofa" never returns a bed. */
export const CATEGORY_TERMS: Set<string> = new Set([
  "sofa", "cornersofa", "sofabed", "bed", "ottomanbed", "armchair", "chair", "footstool", "bedside", "wardrobe",
  "drawers", "diningtable", "coffeetable", "table", "headboard", "rug", "mattress", "bench", "desk", "shelf",
  "bookcase", "cabinet", "sideboard", "mirror", "lamp", "stool", "cushion", "throw",
].map((term) => stem(term)));

const STOP = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "can", "do", "does", "for", "from", "have", "how", "i", "in",
  "is", "it", "its", "me", "my", "of", "on", "or", "our", "please", "show", "that", "the", "this", "to", "what",
  "which", "with", "would", "you", "your", "want", "need", "looking", "something", "some", "one", "ones", "like",
  "there", "they", "them", "do", "get", "got", "us", "we", "will", "should", "could", "about", "im",
]);

const PHRASE_MAP = new Map<string, string>(EQUIVALENT
  .flatMap((group) => group.slice(1).map((phrase) => [normaliseText(phrase), group[0]!] as const))
  .filter(([phrase, canonical]) => phrase !== canonical));
/**
 * One pass over the text; alternatives are ordered longest first so "super king size" wins over "king size".
 * Phrases are already normalised to [a-z0-9 ], so they need no regex escaping.
 */
const PHRASES = new RegExp(`(^| )(${[...PHRASE_MAP.keys()].sort((a, b) => b.length - a.length).join("|")})(?= |$)`, "g");

/** Lowercase, strip accents and punctuation. "Bouclé Grey/Gray" -> "boucle grey gray". */
export function normaliseText(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/(\d)\s*(cm|mm|m|in|ft)\b/g, "$1$2").replace(/[^a-z0-9]+/g, " ").trim();
}

function stem(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) return token.slice(0, -1);
  return token;
}

/** Canonical tokens for indexing and querying. */
const TOKEN_CACHE_LIMIT = 20_000;
const tokenCache = new Map<string, string[]>();

export function tokens(value: string, keepStopWords = false, components = true): string[] {
  // Option values and short labels repeat across thousands of variants; memoise them (bounded).
  const cacheable = value.length <= 120;
  const key = `${keepStopWords ? 1 : 0}${components ? 1 : 0}${value}`;
  const cached = cacheable ? tokenCache.get(key) : undefined;
  if (cached) return cached;
  const text = normaliseText(value).replace(PHRASES, (_match, lead: string, phrase: string) => `${lead}${PHRASE_MAP.get(phrase)}`);
  const result = text.split(" ").filter((token) => token && (keepStopWords || !STOP.has(token))).map(stem)
    .flatMap((token) => components ? [token, ...(COMPONENTS[token] ?? [])] : [token]);
  if (cacheable) {
    if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
    tokenCache.set(key, result);
  }
  return result;
}

export interface WeightedTerm { term: string; weight: number }

/** Query tokens plus one-way related tokens at half weight. */
export function expandQuery(value: string): WeightedTerm[] {
  const seen = new Map<string, number>();
  for (const token of tokens(value)) {
    seen.set(token, Math.max(seen.get(token) ?? 0, 1));
    for (const related of RELATED[token] ?? []) {
      for (const relatedToken of tokens(related)) {
        if (!seen.has(relatedToken)) seen.set(relatedToken, 0.5);
      }
    }
  }
  return [...seen].map(([term, weight]) => ({ term, weight }));
}

/** Whole-meaning token set for repeated containsMeaning checks against the same long text. */
export function meaningTokens(value: string): Set<string> {
  return new Set(tokens(value, true, false));
}

/** True when two option values mean the same thing to a shopper ("Gray" vs "grey", "King Size" vs "King"). */
export function sameMeaning(a: string, b: string): boolean {
  const left = tokens(a, true, false).join(" ");
  const right = tokens(b, true, false).join(" ");
  return !!left && left === right;
}

/** True when every token of `wanted` appears in `value`: "grey" matches "Light Grey Velvet". */
export function containsMeaning(value: string | Set<string>, wanted: string): boolean {
  // Compound sizes stay whole: "King" must not match "Super King".
  const have = typeof value === "string" ? new Set(tokens(value, true, false)) : value;
  const need = tokens(wanted, true, false);
  return need.length > 0 && need.every((token) => have.has(token));
}

export interface IndexedField { text: string; weight: number }

export interface SearchIndex<T> {
  docs: { item: T; tf: Map<string, number>; length: number }[];
  df: Map<string, number>;
  averageLength: number;
}

export function buildIndex<T>(items: T[], fields: (item: T) => IndexedField[]): SearchIndex<T> {
  const df = new Map<string, number>();
  const docs = items.map((item) => {
    const tf = new Map<string, number>();
    let length = 0;
    for (const field of fields(item)) {
      for (const token of tokens(field.text)) {
        tf.set(token, (tf.get(token) ?? 0) + field.weight);
        length += 1;
      }
    }
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    return { item, tf, length };
  });
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  return { docs, df, averageLength };
}

const K1 = 1.2;
const B = 0.6;

/** BM25 score of each document against weighted query terms. Unmatched documents score 0. */
export function scoreIndex<T>(index: SearchIndex<T>, query: WeightedTerm[]): { item: T; score: number; matched: Set<string> }[] {
  const total = index.docs.length;
  return index.docs.map((doc) => {
    let score = 0;
    const matched = new Set<string>();
    for (const { term, weight } of query) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      matched.add(term);
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * doc.length / Math.max(1, index.averageLength)));
      score += weight * idf * norm;
    }
    return { item: doc.item, score, matched };
  });
}

/** Split long merchant text into retrievable sections, keeping headings with their clauses. */
export function chunkText(text: string, maxLength = 1100): string[] {
  const paragraphs = text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z][^.!?]{0,60}:)/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxLength ? paragraph.match(new RegExp(`.{1,${maxLength}}(?:\\s|$)`, "g")) ?? [paragraph] : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 1 > maxLength) {
        chunks.push(current.trim());
        current = "";
      }
      current += `${piece.trim()} `;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Convert merchant HTML (policies, pages) to plain text while preserving block boundaries. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&pound;/g, "£")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n").trim();
}
