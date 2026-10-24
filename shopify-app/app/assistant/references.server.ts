/**
 * Deterministic conversation state for the Room Assistant: which product the shopper means, and the constraints
 * (budget, audience) they have stated. The model never decides these alone: the server resolves them from the latest
 * message and the structured session state, and the tools refuse product choices that contradict them.
 *
 * Reference precedence for the latest shopper message:
 *   1. a product named in the message ("show me Cloud Nine");
 *   2. an ordinal reference to the latest recommendations ("the second one", "option 2");
 *   3. a demonstrative ("this one", "show that", "it") → the shopper's own card selection;
 *   4. … → the conversation's current selection, if it is consistent with the latest constraints;
 *   5. otherwise ambiguous: the assistant asks one short question.
 * "Pick one for me" lets the assistant choose, but only among products that satisfy the constraints.
 */
import { normaliseText } from "./text";

export type SelectionSource = "card" | "options" | "conversation";
export interface Selection { productRef: string; variantRef: string | null; source: SelectionSource }
export interface Constraints {
  budgetMax: number | null;
  budgetMin: number | null;
  /** The currency symbol or code the shopper used, if any (e.g. "$"), for transparent comparison with store prices. */
  budgetCurrency: string | null;
  /** True once the shopper has said they are shopping for a child. */
  forChildren: boolean;
}
export interface Candidate { productRef: string; title: string; minPrice: number | null; children: boolean }

export type Resolution =
  | { kind: "named"; productRef: string }
  | { kind: "ordinal"; productRef: string; position: number }
  | { kind: "selected"; productRef: string; variantRef: string | null; source: SelectionSource }
  | { kind: "choose_for_me" }
  | { kind: "ambiguous"; candidates: string[]; reason: "several_recent" | "selection_conflicts_with_constraints" }
  | { kind: "none" };

export const EMPTY_CONSTRAINTS: Constraints = { budgetMax: null, budgetMin: null, budgetCurrency: null, forChildren: false };

const CURRENCY = String.raw`(?:[$£€]|usd|gbp|eur|dollars?|pounds?|euros?)`;
// Thousands separators first ("1,200", "1,200.50"), then plain or decimal-comma amounts ("250", "249,99").
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,7}(?:[.,]\d{1,2})?)`;
const amount = (value: string) => Number(/^\d{1,3}(?:,\d{3})+/.test(value) ? value.replace(/,/g, "") : value.replace(",", "."));

/** A budget stated in one message: "my budget is $250", "under £400", "max 300", "between 200 and 400", "250$". */
export function parseBudget(message: string): Pick<Constraints, "budgetMax" | "budgetMin" | "budgetCurrency"> | "cleared" | null {
  const text = message.toLowerCase();
  if (/\b(no|any|forget (?:the|my)?|ignore (?:the|my)?|remove (?:the|my)?)\s*(budget|price limit)\b|\bmoney is no object\b/.test(text)) return "cleared";
  const symbol = (raw: string) => {
    const match = raw.match(/[$£€]|usd|gbp|eur|dollar|pound|euro/);
    if (!match) return null;
    return ({ usd: "$", dollar: "$", gbp: "£", pound: "£", eur: "€", euro: "€" } as Record<string, string>)[match[0]] ?? match[0];
  };
  const range = text.match(new RegExp(String.raw`between\s*${CURRENCY}?\s*${AMOUNT}\s*${CURRENCY}?\s*(?:and|-|to)\s*${CURRENCY}?\s*${AMOUNT}\s*${CURRENCY}?`));
  if (range) {
    const [low, high] = [amount(range[1]!), amount(range[2]!)].sort((a, b) => a - b);
    return { budgetMin: low!, budgetMax: high!, budgetCurrency: symbol(range[0]) };
  }
  const patterns = [
    new RegExp(String.raw`budget\D{0,20}?${CURRENCY}?\s*${AMOUNT}\s*${CURRENCY}?`),
    new RegExp(String.raw`(?:under|below|less than|up to|upto|max(?:imum)?|no more than|within|cheaper than|at most)\s*${CURRENCY}?\s*${AMOUNT}\s*${CURRENCY}?`),
    new RegExp(String.raw`${CURRENCY}\s*${AMOUNT}\s*(?:budget|max|or less|maximum)`),
    new RegExp(String.raw`${AMOUNT}\s*${CURRENCY}\s*(?:budget|max|or less|maximum)?`),
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    // A bare "250$" only counts when the message is about budget or price.
    if (index === 3 && !/budget|price|cost|afford|spend|under|max/.test(text)) continue;
    const value = amount(match[1]!);
    if (!Number.isFinite(value) || value <= 0) continue;
    return { budgetMax: value, budgetMin: null, budgetCurrency: symbol(match[0]) };
  }
  return null;
}

const CHILD_WORDS = /\b(kids?|child|children|childrens|children's|toddlers?|baby|babies|nursery|juniors?|son|daughter|boys?|girls?|teen(?:ager)?s?|little one)\b/i;
const ADULT_WORDS = /\b(master bedroom|our bedroom|my bedroom|for me|for us|adults?|guest room|couple)\b/i;

/** Whether a message says the shopper is buying for a child; false when it clearly says otherwise; null if silent. */
export function childrenIntent(message: string): boolean | null {
  if (/\b(not|no|isn'?t|aren'?t)\s+(for\s+)?(a\s+)?(kids?|child|children)\b/i.test(message) || ADULT_WORDS.test(message)) return false;
  return CHILD_WORDS.test(message) ? true : null;
}

/** Children's products, from merchant data (title, type, tags, collections). */
export function isChildrensProduct(product: { title: string; productType?: string; tags?: string[]; collections?: { title: string }[] }): boolean {
  const text = [product.title, product.productType ?? "", ...(product.tags ?? []), ...(product.collections ?? []).map((entry) => entry.title)].join(" ");
  return /\b(kids?|child|children|childrens|children's|toddlers?|baby|nursery|junior|cot|crib)\b/i.test(text);
}

/** Folds the latest message into the persisted constraints. The latest explicit statement always wins. */
export function nextConstraints(previous: Constraints | null, message: string): Constraints {
  const base = previous ?? EMPTY_CONSTRAINTS;
  const budget = parseBudget(message);
  const children = childrenIntent(message);
  return {
    ...base,
    ...(budget === "cleared" ? { budgetMax: null, budgetMin: null, budgetCurrency: null } : budget ?? {}),
    forChildren: children === null ? base.forChildren : children,
  };
}

const GENERIC = new Set([
  "bed", "beds", "frame", "upholstered", "kids", "kid", "the", "and", "with", "headboard", "curved", "storage", "ottoman",
  "double", "king", "single", "small", "super", "size", "sofa", "chair", "modern", "luxe", "boucle", "velvet", "fabric",
  "grey", "gray", "beige", "cream", "white", "black", "pink", "blue", "green", "oak", "wood", "wooden", "panelled", "paneled",
]);

const STRUCTURAL = new Set(["bed", "beds", "frame", "the", "and", "with", "kids", "kid", "size"]);

/** Words that identify a product by name ("egerie", "cloud nine"); `named` is false for titles made only of colour/style words. */
function distinctive(title: string): { tokens: string[]; named: boolean } {
  const words = normaliseText(title).split(" ").filter((word) => word.length > 1 && !/^\d+$/.test(word));
  const named = words.filter((word) => !GENERIC.has(word));
  return named.length ? { tokens: named, named: true } : { tokens: words.filter((word) => !STRUCTURAL.has(word)), named: false };
}

/**
 * A product named in the message, allowing a truncated last word ("cloud nine u", "egerie"). Requires the product's
 * first distinctive word, and the second as well when another candidate shares the first. A real name ("Aria") beats
 * a title made of colour words ("Cream Bed") matching "in cream". Null when none or several.
 */
export function namedProduct(message: string, candidates: Candidate[]): string | null {
  const words = normaliseText(message).split(" ").filter(Boolean);
  const keys = new Map(candidates.map((candidate) => [candidate, distinctive(candidate.title)]));
  const matches = candidates.filter((candidate) => {
    const { tokens } = keys.get(candidate)!;
    if (!tokens.length || !words.includes(tokens[0]!)) return false;
    const shared = candidates.some((other) => other !== candidate && keys.get(other)!.tokens[0] === tokens[0]);
    if (!shared || tokens.length === 1) return true;
    const next = words[words.indexOf(tokens[0]!) + 1];
    return !!next && (next === tokens[1] || tokens[1]!.startsWith(next));
  });
  const named = matches.filter((candidate) => keys.get(candidate)!.named);
  const unique = [...new Set((named.length ? named : matches).map((candidate) => candidate.productRef))];
  return unique.length === 1 ? unique[0]! : null;
}

/** Whether the message mentions the product by its name, even when the name alone does not single it out. */
export function mentionsProduct(message: string, title: string): boolean {
  const { tokens, named } = distinctive(title);
  return named && normaliseText(message).split(" ").includes(tokens[0]!);
}

const ORDINALS: [RegExp, number][] = [
  [/\b(first|1st|option (?:1|one)|number (?:1|one)|no\.? ?1)\b/i, 0],
  [/\b(second|2nd|option (?:2|two)|number (?:2|two)|no\.? ?2)\b/i, 1],
  [/\b(third|3rd|option (?:3|three)|number (?:3|three)|no\.? ?3)\b/i, 2],
  [/\b(last one|the last)\b/i, -1],
];
const DEMONSTRATIVE = /\b(this|that|tha|thi|it|these|those|this one|that one|the bed|same one|selected one)\b/i;
const CHOOSE_FOR_ME = /\b(select|pick|choose|recommend)\s+(one|any|a bed|the best|for me)\b|\byou (choose|pick|decide|select)\b|\bwhich (one )?(is|would be) best\b/i;

/** Resolves which product the latest message refers to. Pure; callers verify the result against Shopify. */
export function resolveReference(message: string, input: {
  shown: string[];
  selected: Selection | null;
  constraints: Constraints;
  candidates: Candidate[];
}): Resolution {
  const named = namedProduct(message, input.candidates);
  if (named) return { kind: "named", productRef: named };
  for (const [pattern, position] of ORDINALS) {
    if (!pattern.test(message) || !input.shown.length) continue;
    const ref = position < 0 ? input.shown.at(-1) : input.shown[position];
    if (ref) return { kind: "ordinal", productRef: ref, position: position < 0 ? input.shown.length : position + 1 };
  }
  if (CHOOSE_FOR_ME.test(message)) {
    // Right after choosing a card, "select one" / "select this" confirms that card; it is not a licence to swap it.
    const own = input.selected && input.selected.source !== "conversation" ? input.selected : null;
    return own && !/\b(another|different|other|instead|for me|you (choose|pick|decide|select))\b/i.test(message) ? { kind: "selected", ...own } : { kind: "choose_for_me" };
  }
  // Only a message that points at a product ("this", "show it") resolves to a selection; "my budget is $250" does not.
  if (!DEMONSTRATIVE.test(message)) return { kind: "none" };
  const selected = input.selected;
  if (selected) {
    // The shopper's own card choice is explicit; a conversation selection must still fit the latest constraints.
    if (selected.source !== "conversation") return { kind: "selected", ...selected };
    const candidate = input.candidates.find((entry) => entry.productRef === selected.productRef);
    const overBudget = !!candidate && candidate.minPrice !== null && input.constraints.budgetMax !== null && candidate.minPrice > input.constraints.budgetMax;
    const wrongAudience = !!candidate && candidate.children && !input.constraints.forChildren;
    if (!overBudget && !wrongAudience) return { kind: "selected", ...selected };
    return { kind: "ambiguous", candidates: input.shown.filter((ref) => ref !== selected.productRef).slice(0, 3), reason: "selection_conflicts_with_constraints" };
  }
  if (input.shown.length === 1) return { kind: "ordinal", productRef: input.shown[0]!, position: 1 };
  return input.shown.length ? { kind: "ambiguous", candidates: input.shown.slice(0, 3), reason: "several_recent" } : { kind: "none" };
}
