/**
 * Room Assistant conversation state, kept in this browser tab's sessionStorage only.
 *
 * - Scoped by shop: the key includes the shop domain and the stored shop is re-checked on load.
 * - Expires after 4 hours idle or 24 hours in total, and is capped at ~100 KB (oldest entries are dropped first).
 * - Never contains image bytes or object URLs: photos live in memory only; room photos are reduced to the
 *   structured observations returned by the server.
 * - Nothing here is sent to Tryora's database or analytics. Each message sends only a bounded slice to the server.
 */

export interface Money { price: string | null; maxPrice: string | null; currencyCode: string }

export interface Recommendation extends Money {
  id: string;
  productRef: string;
  variantRef: string | null;
  productId: string;
  variantId: string | null;
  title: string;
  url: string;
  /** A real Shopify image URL, or null. */
  image: string | null;
  /** Optional for conversations saved before image sources were recorded. */
  imageAlt?: string;
  imageSource?: "variant" | "reference" | "product" | null;
  referenceImage?: string | null;
  options: Record<string, string>;
  purchaseAvailable: boolean;
  previewAvailable: boolean;
  previewStatus: "available" | "not_configured" | "unavailable" | "choose_options" | "product_page";
  /** Server-provided explanation when previewAvailable is false (optional for older saved conversations). */
  previewReason?: string | null;
  optionValue: string | null;
  previewContext?: { mappingRevision: string; sourceVariantId: string; pageSourceVariantId?: string };
  variantCount?: number;
  hasOptions?: boolean;
  reason: string;
}

export interface RoomNotes {
  colours: string[];
  style: string;
  lighting: string;
  notes: string;
  walls?: string;
  floor?: string;
  furniture?: string[];
  layout?: string;
  placement?: string[];
}

export interface Preferences {
  budgetMin: number | null;
  budgetMax: number | null;
  colours: string[];
  materials: string[];
  sizes: string[];
  furniture: string[];
  roomDimensions: string;
  roomNotes?: string;
}

export interface Ref { productRef: string; variantRef: string | null }
/** How the selection was made: the shopper's own card or option choice is authoritative over the conversation. */
export type SelectionSource = "card" | "options" | "conversation";
export interface Selection extends Ref { source: SelectionSource }
/** Budget and audience the shopper stated; the server updates them every turn. */
export interface Constraints { budgetMax: number | null; budgetMin: number | null; budgetCurrency: string | null; forChildren: boolean }

export type Entry =
  | { id: string; kind: "user"; text: string; photo: boolean; at: number }
  | {
    id: string;
    kind: "assistant";
    text: string;
    status: "streaming" | "done" | "error" | "stopped";
    stage?: string;
    error?: string;
    /** The user entry this answers, so Retry re-sends the same question instead of duplicating it. */
    replyTo: string;
    recommendations: Recommendation[];
    visualise: Recommendation | null;
    /** True when the cards are one product the shopper asked to see, not a numbered set of options. */
    focus?: boolean;
    at: number;
  }
  | { id: string; kind: "preview"; item: Recommendation; status: "generating" | "ready" | "failed"; stage?: string; error?: string; handoff?: string; at: number }
  | { id: string; kind: "notice"; text: string; at: number }
  /** The merchant's email step for previews. The email itself is never stored here. */
  | { id: string; kind: "lead"; item: Recommendation; status: "open" | "sending" | "done" | "skipped"; after: boolean; error?: string; at: number };

export interface ChatState {
  v: 2;
  shop: string;
  createdAt: number;
  updatedAt: number;
  entries: Entry[];
  room: RoomNotes | null;
  preferences: Preferences | null;
  shown: Ref[];
  /** Every product shown in this chat's recommendation batches, so "show more" never repeats one (optional for older sessions). */
  explored?: Ref[];
  selected: Selection | null;
  constraints: Constraints | null;
  ui: { open: boolean; view: "side" | "fullscreen" };
  /** Whether this session already completed (or skipped, where allowed) the merchant's email step. */
  lead: { done: boolean };
  /** Previews delivered in this session; "after" email timing allows the first one before asking. */
  previewsDelivered: number;
}

export const IDLE_MS = 4 * 60 * 60_000;
export const MAX_AGE_MS = 24 * 60 * 60_000;
export const MAX_BYTES = 100_000;
export const MAX_ENTRIES = 60;
const LEGACY_KEY = "tryora_assistant_context";

export const sessionKey = (shop: string) => `tryora_assistant_v2:${shop}`;

export function emptyState(shop: string, view: "side" | "fullscreen" = "side", now = Date.now()): ChatState {
  return { v: 2, shop, createdAt: now, updatedAt: now, entries: [], room: null, preferences: null, shown: [], explored: [], selected: null, constraints: null, ui: { open: false, view }, lead: { done: false }, previewsDelivered: 0 };
}

function storage(): Storage | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

/** Loads this shop's conversation, discarding expired, foreign or malformed state. */
export function loadState(shop: string, view: "side" | "fullscreen" = "side", now = Date.now()): ChatState {
  const store = storage();
  try {
    // v1 kept one store-agnostic key; remove it so no earlier context can leak between stores.
    store?.removeItem(LEGACY_KEY);
    const raw = store?.getItem(sessionKey(shop));
    if (!raw) return emptyState(shop, view, now);
    const parsed = JSON.parse(raw) as ChatState;
    const valid = parsed && parsed.v === 2 && parsed.shop === shop && Array.isArray(parsed.entries) &&
      now - parsed.updatedAt < IDLE_MS && now - parsed.createdAt < MAX_AGE_MS;
    if (!valid) {
      store?.removeItem(sessionKey(shop));
      return emptyState(shop, view, now);
    }
    // A turn or preview interrupted by navigation cannot resume; show it as stopped rather than spinning forever.
    parsed.entries = parsed.entries.map((entry) =>
      entry.kind === "assistant" && entry.status === "streaming" ? { ...entry, status: "stopped" as const, stage: undefined } :
        entry.kind === "preview" && entry.status === "generating" ? { ...entry, status: "failed" as const, error: "The preview was interrupted when the page changed. No credit was used." } :
          entry.kind === "lead" && entry.status === "sending" ? { ...entry, status: "open" as const } :
            entry);
    return {
      ...emptyState(shop, view, now),
      ...parsed,
      ui: { open: !!parsed.ui?.open, view: parsed.ui?.view === "fullscreen" ? "fullscreen" : "side" },
      lead: { done: parsed.lead?.done === true },
      selected: parsed.selected?.productRef ? { ...parsed.selected, source: parsed.selected.source ?? "conversation" } : null,
      constraints: parsed.constraints && typeof parsed.constraints === "object" ? parsed.constraints : null,
      previewsDelivered: Number.isInteger(parsed.previewsDelivered) && parsed.previewsDelivered > 0 ? parsed.previewsDelivered : 0,
    };
  } catch {
    return emptyState(shop, view, now);
  }
}

/** Serialises within the size cap, dropping the oldest entries first. Returns what was actually kept. */
export function serialise(state: ChatState): string {
  const copy: ChatState = { ...state, entries: state.entries.slice(-MAX_ENTRIES) };
  let text = JSON.stringify(copy);
  while (text.length > MAX_BYTES && copy.entries.length) {
    copy.entries = copy.entries.slice(Math.max(1, Math.ceil(copy.entries.length / 5)));
    text = JSON.stringify(copy);
  }
  return text;
}

export function saveState(state: ChatState, now = Date.now()) {
  state.updatedAt = now;
  const store = storage();
  try {
    if (!state.entries.length && !state.room && !state.preferences && !state.ui.open) store?.removeItem(sessionKey(state.shop));
    else store?.setItem(sessionKey(state.shop), serialise(state));
  } catch { /* Full or blocked storage: the chat keeps working in memory. */ }
}

/** Whether the drawer was open when the shopper left the previous page in this tab. */
export function wasOpen(shop: string): boolean {
  return loadState(shop).ui.open;
}

/**
 * Shopper messages older than the verbatim history window, as short reminders (up to 6, 160 characters each), so
 * long conversations keep early preferences without resending every turn.
 */
export function earlierFor(state: ChatState, upTo?: string): string[] {
  const recent = new Set(historyFor(state, upTo).filter((message) => message.role === "user").map((message) => message.content));
  const end = upTo ? state.entries.findIndex((entry) => entry.id === upTo) : state.entries.length;
  return state.entries.slice(0, end < 0 ? undefined : end)
    .filter((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user" && !recent.has(entry.text.slice(0, 800)))
    .map((entry) => entry.text.slice(0, 160))
    .slice(-6);
}

/** The bounded text history sent with a message: the last 12 completed user/assistant turns. */
export function historyFor(state: ChatState, upTo?: string): { role: "user" | "assistant"; content: string }[] {
  const entries = upTo ? state.entries.slice(0, state.entries.findIndex((entry) => entry.id === upTo) + 1) : state.entries;
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") messages.push({ role: "user", content: entry.text.slice(0, 800) });
    else if (entry.kind === "assistant" && entry.status === "done" && entry.text.trim()) {
      messages.push({ role: "assistant", content: entry.text.slice(0, 2000) });
    }
    else if (entry.kind === "preview" && entry.status === "ready") {
      // The model must know when a preview was really displayed, not merely suggested.
      const note = `AI room preview already generated and shown for ${entry.item.title} (productRef ${entry.item.productRef}${entry.item.variantRef ? `, variantRef ${entry.item.variantRef}` : ""}).`;
      const previous = messages.at(-1);
      if (previous?.role === "assistant") previous.content = `${previous.content}\n${note}`.slice(-2000);
      else messages.push({ role: "assistant", content: note });
    }
  }
  // The server requires alternating context ending with the shopper; drop unanswered earlier questions.
  const cleaned: typeof messages = [];
  for (const message of messages) {
    if (cleaned.at(-1)?.role === message.role) cleaned[cleaned.length - 1] = message;
    else cleaned.push(message);
  }
  return cleaned.slice(-12);
}
