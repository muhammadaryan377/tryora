// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
/**
 * Guesses a swatch colour from a colour name, e.g. "Navy" or "Dark Grey Velvet".
 * Only used when the merchant has no swatch colours in Shopify AND has approved guessing (owner decision, 19 Oct 2026).
 * Returns null when no word in the name is a known colour, so the merchant is asked to pick that one by hand.
 */

const COLOURS: Record<string, string> = {
  // Basics
  black: "#1c1c1c", white: "#f7f7f5", grey: "#9a9a9a", gray: "#9a9a9a", red: "#b3261e", green: "#3f7a46",
  blue: "#2f5d9e", yellow: "#e2c044", orange: "#d9772b", purple: "#6c4a8a", pink: "#e3a1b4", brown: "#6e4a32",
  beige: "#d9c8ad", cream: "#efe6d2", gold: "#c9a24a", silver: "#bfc2c5", tan: "#c4a07a", teal: "#2f7f80",
  turquoise: "#3fb1b0", lilac: "#c3a9d6", lavender: "#b9a7d8", violet: "#7a5aa6", maroon: "#6b1f2a",
  // Furniture and fabric names
  oat: "#d8c6ae", oatmeal: "#d6c6ad", olive: "#6b6a2e", rust: "#b5532a", sand: "#cdb79a", stone: "#a59e93",
  ivory: "#ece4d6", chalk: "#e6e1d8", taupe: "#9c8a78", mink: "#8b7766", charcoal: "#4a4a4a", graphite: "#4f5357",
  slate: "#6f7a83", pebble: "#a69e94", cocoa: "#6b4a3a", chocolate: "#5a3a2a", espresso: "#3e2b22", coffee: "#6f4e37",
  mocha: "#7b5b48", latte: "#c8ad8f", caramel: "#b07a45", camel: "#b88a5a", mustard: "#c9962e", ochre: "#c08a3e",
  terracotta: "#c06a4a", blush: "#e0b2a8", rose: "#c9a39a", dusky: "#b58b8b", burgundy: "#7d2533", wine: "#6e2233",
  claret: "#6a1f2b", plum: "#5e3550", aubergine: "#3f2a3b", sage: "#9aa68a", forest: "#355e3b", emerald: "#2e7d5b",
  bottle: "#244a35", moss: "#6b7445", khaki: "#a39b6b", navy: "#24345a", midnight: "#1f2a44", indigo: "#33407a",
  denim: "#4a6a8f", sky: "#9cc3e0", duck: "#2f6d73", ocean: "#2c5f7c", petrol: "#2f5560", jade: "#4f9a80",
  mint: "#a9d4bf", coral: "#e07a62", peach: "#f0bfa0", apricot: "#eab07a", saffron: "#e3a43a", amber: "#c9862f",
  copper: "#b26a3c", bronze: "#8c6239", brass: "#b59a52", natural: "#d8c4a0", linen: "#e6dccb", ecru: "#e4dac4",
  biscuit: "#d6b98f", mushroom: "#a39283", putty: "#bdb2a0", fawn: "#c9ae8a", truffle: "#5c4a40", steel: "#7c8791",
  smoke: "#8d8f92", ash: "#b2b0aa", pewter: "#8a8d8f", cloud: "#dfe1e2", snow: "#f4f4f2", pearl: "#e9e5dc",
  magnolia: "#f1e7d8", vanilla: "#f2e6c7", butter: "#f0d98a", lemon: "#efd85a", lime: "#a7c34a", walnut: "#5e4330",
  oak: "#b08a5b", teak: "#9a6a3e", mahogany: "#6b2f22", cherry: "#7a2e2a", pine: "#c9a46a",
};

const SYNONYMS: Record<string, string> = { gray: "grey", greys: "grey", greige: "putty", off: "", "off-white": "ivory" };
const LIGHT = new Set(["light", "pale", "soft", "dusty", "powder", "baby"]);
const DARK = new Set(["dark", "deep", "rich", "midnight"]);

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

export function guessColour(name: string): string | null {
  const words = name
    .toLowerCase()
    .replace(/off[\s-]white/g, "ivory")
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map((w) => SYNONYMS[w] ?? w)
    .filter(Boolean);
  // The last colour word usually carries the colour ("Dusky Rose Velvet" -> rose).
  let base: string | null = null;
  for (const w of words) if (COLOURS[w]) base = COLOURS[w]!;
  if (!base) return null;
  if (words.some((w) => LIGHT.has(w))) return shade(base, 0.35);
  if (words.some((w) => DARK.has(w))) return shade(base, -0.35);
  return base;
}

export type SwatchSource = "shopify" | "merchant" | "guess" | "missing";

export interface SwatchInput {
  value: string;
  /** Swatch colour or image set on the option value in Shopify. */
  shopifyColour?: string | null;
  shopifyImage?: string | null;
}

export interface ResolvedSwatch {
  value: string;
  colour: string | null;
  image: string | null;
  source: SwatchSource;
}

/**
 * Picks each colour's swatch: Shopify's own swatch first, then a colour the merchant set in Tryora,
 * then (only if the merchant approved guessing) a colour guessed from the name. Anything left is "missing".
 */
export function resolveSwatches(
  values: SwatchInput[],
  merchantColours: Record<string, string>,
  guessApproved: boolean,
): ResolvedSwatch[] {
  return values.map((v) => {
    if (v.shopifyColour || v.shopifyImage) {
      return { value: v.value, colour: v.shopifyColour ?? null, image: v.shopifyImage ?? null, source: "shopify" };
    }
    const own = merchantColours[v.value];
    if (own && /^#[0-9a-fA-F]{6}$/.test(own)) return { value: v.value, colour: own, image: null, source: "merchant" };
    const guess = guessApproved ? guessColour(v.value) : null;
    if (guess) return { value: v.value, colour: guess, image: null, source: "guess" };
    return { value: v.value, colour: null, image: null, source: "missing" };
  });
}
