/**
 * Room Assistant 2.0: a right-side chat drawer (fullscreen on phones, optional fullscreen on desktop).
 *
 * The shell is rendered once; streaming updates touch only the affected message, so the composer, focus and
 * scroll position are never reset mid-answer. Conversation state lives in session.ts (sessionStorage, per shop);
 * photos and generated images exist only as in-memory object URLs.
 */
import { errorMessage, escapeHtml, formatText, money, STAGE_LABELS } from "./format.js";
import { runTurn, TurnError, type TurnEvent } from "./transport.js";
import { generatePreview, PREVIEW_STAGES, PreviewError, previewErrorMessage } from "./preview.js";
import { PhotoError, prepareRoomPhoto, type PreparedPhoto } from "./photo.js";
import { earlierFor, historyFor, loadState, saveState, type ChatState, type Entry, type Recommendation, type SelectionSource } from "./session.js";
import { cardForVariant, resolveVariant, selectionsFor, valuesFor, type ProductOptions } from "./options.js";
import { PROXY } from "./transport.js";
import { tagBasket } from "../attribution.js";

export interface AssistantConfig {
  enabled: boolean;
  configured: boolean;
  providerReady: boolean;
  greeting: string;
  shop?: string;
  defaultView?: "side" | "fullscreen";
  transport?: "poll" | "sse";
  /** The merchant's email step for previews, as the product popup applies it. Absent on older servers. */
  lead?: { mode: "required" | "skippable" | "off"; timing: "before" | "after"; showOptIn: boolean; optInWording: string };
  /** False when the store has no preview credits left. */
  previewsAvailable?: boolean;
  launcher: { label: string; position: "bottom-left" | "bottom-right"; colour: string };
}

export interface AssistantContext {
  /** Shopify product ID (numeric or GID) of the page being viewed, if any. */
  productId?: string;
  /** Opens the existing product popup when this product is preview-enabled. */
  openCurrentPreview?: () => void;
  launcher?: HTMLElement | null;
  /** The variant currently selected in the product form, if any. */
  currentVariantId?: () => string | null;
  preparePhoto?: (file: File) => Promise<PreparedPhoto>;
}

type AssistantEntry = Extract<Entry, { kind: "assistant" }>;
type PreviewEntry = Extract<Entry, { kind: "preview" }>;
type LeadEntry = Extract<Entry, { kind: "lead" }>;

interface CardOptionsState { productId: string; data: ProductOptions | null; selections: Record<string, string>; loading: boolean; error: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isDefaultTitle = (name: string, value: string) => name === "Title" && value === "Default Title";

const ICONS = {
  spark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l1.9 5.3 5.3 1.9-5.3 1.9L12 17.2l-1.9-5.3L4.8 10l5.3-1.9z" fill="currentColor"/><path d="M18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="currentColor" opacity=".7"/></svg>`,
  minimise: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  restore: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4l-6 6M14 4v6h6M4 20l6-6M10 20v-6H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  more: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  send: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>`,
  room: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1H4a1 1 0 01-1-1z M9 21v-6h6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  sofa: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11V8a2 2 0 012-2h12a2 2 0 012 2v3M2 13a2 2 0 014 0v2h12v-2a2 2 0 014 0v5H2zM5 18v2M19 18v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 10h8M8 13h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  photo: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 16l5-5 4 4 3-3 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
};

const SUGGESTIONS = ["Show me grey beds", "Do you have velvet sofas?", "What is your returns policy?"];

function storedVisitorId() {
  try {
    const existing = localStorage.getItem("tryora_vid");
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem("tryora_vid", id);
    return id;
  } catch { return crypto.randomUUID(); }
}

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const gid = (id: string | undefined) => !id ? undefined : id.startsWith("gid://") ? id : /^\d+$/.test(id) ? `gid://shopify/Product/${id}` : undefined;
const numeric = (id: string | undefined | null) => id?.split("/").pop() ?? "";
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export class RoomAssistant {
  private root: HTMLElement | null = null;
  private state: ChatState;
  private readonly shop: string;
  private visible = false;
  private attachment: PreparedPhoto | null = null;
  private preparing = false;
  private composerError = "";
  /** The most recent room photo the shopper sent, kept in memory for previews only. */
  private roomPhoto: PreparedPhoto | null = null;
  private readonly photoUrls = new Map<string, string>();
  private readonly previewUrls = new Map<string, string>();
  private active: { controller: AbortController; entryId: string } | null = null;
  private readonly previews = new Map<string, AbortController>();
  private pendingPreview: Recommendation | null = null;
  private pendingIntent: "recommend" | "visualise" | null = null;
  private menu: "none" | "more" | "attach" = "none";
  private lastFocus: HTMLElement | null = null;
  private lastAnnounced = "";
  /** In-card option selectors, keyed by "<entry id>:<card index>". Memory only. */
  private readonly cardOptions = new Map<string, CardOptionsState>();
  private readonly optionsCache = new Map<string, ProductOptions>();
  /** Typed email form values, memory only (never saved to session storage). */
  private readonly leadDrafts = new Map<string, { email: string; firstName: string; marketing: boolean }>();

  constructor(private readonly config: AssistantConfig, private readonly context: AssistantContext = {}) {
    this.shop = config.shop || (typeof location !== "undefined" ? location.hostname : "store");
    this.state = loadState(this.shop, config.defaultView ?? "side");
  }

  get isOpen() { return this.visible; }
  get view() { return this.state.ui.view; }

  // ---------- lifecycle ----------

  open() {
    if (!this.root) this.mount();
    if (this.visible) return;
    this.lastFocus = (document.activeElement as HTMLElement | null) ?? null;
    this.visible = true;
    this.root!.hidden = false;
    this.root!.dataset.state = "open";
    this.state.ui.open = true;
    this.save();
    this.syncLauncher();
    this.syncLock();
    this.renderAll();
    this.scrollToEnd(false);
    this.textarea()?.focus();
  }

  /** Hides the drawer but keeps everything, including a running answer or preview. */
  minimise() {
    if (!this.root || !this.visible) return;
    this.visible = false;
    this.menu = "none";
    this.root.hidden = true;
    this.root.dataset.state = "minimised";
    this.state.ui.open = false;
    this.save();
    this.syncLauncher();
    this.syncLock();
    (this.context.launcher ?? this.lastFocus)?.focus?.();
  }

  /** Closes the drawer. The conversation stays in this tab's session and is restored on reopen. */
  close() {
    this.minimise();
    this.context.launcher?.classList.remove("has-unread");
  }

  setView(view: "side" | "fullscreen") {
    this.state.ui.view = view;
    this.save();
    if (this.root) this.root.dataset.view = view;
    this.syncLock();
    this.renderHeader();
  }

  toggleFullscreen() { this.setView(this.state.ui.view === "fullscreen" ? "side" : "fullscreen"); }

  /** Starts a new conversation but keeps the room analysis and photo. */
  newChat() {
    this.abortAll();
    this.state.entries = [];
    this.state.shown = [];
    this.state.selected = null;
    this.state.constraints = null;
    this.state.preferences = null;
    this.cardOptions.clear();
    this.save();
    this.menu = "none";
    this.renderAll();
    this.textarea()?.focus();
  }

  /** Removes everything: messages, recommendations, preferences, room notes and photos. */
  clearConversation() {
    this.abortAll();
    this.forgetRoom(false);
    this.state.entries = [];
    this.state.shown = [];
    this.state.selected = null;
    this.state.constraints = null;
    this.state.preferences = null;
    this.state.lead = { done: false };
    this.state.previewsDelivered = 0;
    this.cardOptions.clear();
    this.leadDrafts.clear();
    for (const url of this.previewUrls.values()) URL.revokeObjectURL(url);
    this.previewUrls.clear();
    this.save();
    this.menu = "none";
    this.renderAll();
  }

  /** Drops the room notes and the in-memory room photo. Messages stay. */
  forgetRoom(render = true) {
    this.state.room = null;
    const urls = new Set([...this.photoUrls.values(), this.roomPhoto?.url, this.attachment?.url].filter((url): url is string => !!url));
    for (const url of urls) URL.revokeObjectURL(url);
    this.photoUrls.clear();
    this.roomPhoto = null;
    this.attachment = null;
    this.save();
    if (render) { this.menu = "none"; this.renderAll(); }
  }

  stop() { this.active?.controller.abort(); }

  // ---------- conversation ----------

  async send(raw?: string) {
    const textarea = this.textarea();
    let text = (raw ?? textarea?.value ?? "").trim();
    if (this.active || this.preparing) return;
    const photo = this.attachment;
    if (!text && !photo) return;
    if (!text) text = this.pendingIntent === "visualise" ? "Show this product in my room." : "Which furniture from this store would suit my room?";
    text = text.slice(0, 800);
    const user: Entry = { id: uid(), kind: "user", text, photo: !!photo, at: Date.now() };
    if (photo) {
      this.photoUrls.set(user.id, photo.url);
      this.roomPhoto = photo;
      this.attachment = null;
    }
    if (this.pendingIntent === "visualise" && this.context.productId) {
      const variant = this.context.currentVariantId?.();
      this.state.selected = { productRef: numeric(this.context.productId), variantRef: variant && /^\d+$/.test(variant) ? variant : null, source: "options" };
    }
    this.pendingIntent = null;
    if (textarea) { textarea.value = ""; this.autosize(); }
    this.state.entries.push(user);
    this.save();
    this.renderAll();
    this.scrollToEnd(true);
    await this.ask(user.id, photo?.blob);
    if (this.pendingPreview && this.roomPhoto) {
      const item = this.pendingPreview;
      this.pendingPreview = null;
      void this.startPreview(item);
    }
  }

  async retry(entryId: string) {
    if (this.active) return;
    const failed = this.state.entries.find((entry): entry is AssistantEntry => entry.id === entryId && entry.kind === "assistant");
    if (!failed || (failed.status !== "error" && failed.status !== "stopped")) return;
    const user = this.state.entries.find((entry) => entry.id === failed.replyTo);
    if (!user || user.kind !== "user") return;
    this.state.entries = this.state.entries.filter((entry) => entry.id !== entryId);
    this.save();
    this.renderAll();
    // The same question is re-sent once; a photo is re-sent only if it is still in memory.
    await this.ask(user.id, user.photo && this.photoUrls.has(user.id) ? this.roomPhoto?.blob : undefined);
  }

  private async ask(userId: string, photo?: Blob) {
    const reply: AssistantEntry = {
      id: uid(), kind: "assistant", text: "", status: "streaming", stage: photo ? "analysing_room" : "understanding",
      replyTo: userId, recommendations: [], visualise: null, at: Date.now(),
    };
    const at = this.state.entries.findIndex((entry) => entry.id === userId);
    this.state.entries.splice(at + 1, 0, reply);
    const controller = new AbortController();
    this.active = { controller, entryId: reply.id };
    this.renderAll();
    this.renderComposer();
    this.scrollToEnd(true);

    const form = new FormData();
    const visitor = storedVisitorId();
    form.set("visitor", visitor);
    form.set("history", JSON.stringify(historyFor(this.state, userId)));
    const product = gid(this.context.productId);
    if (product) form.set("product", product);
    form.set("hasPhoto", this.roomPhoto ? "1" : "0");
    if (this.state.room) form.set("room", JSON.stringify(this.state.room));
    if (this.state.shown.length) form.set("shown", JSON.stringify(this.state.shown.slice(0, 6)));
    if (this.state.selected) form.set("selected", JSON.stringify(this.state.selected));
    if (this.state.preferences) form.set("preferences", JSON.stringify(this.state.preferences));
    if (this.state.constraints) form.set("constraints", JSON.stringify(this.state.constraints));
    const earlier = earlierFor(this.state, userId);
    if (earlier.length) form.set("earlier", JSON.stringify(earlier));
    if (photo) form.set("photo", photo, "room.jpg");

    try {
      await runTurn(form, {
        transport: this.config.transport ?? "poll",
        visitor,
        signal: controller.signal,
        onEvent: (event) => this.onEvent(reply.id, event),
        onUploadProgress: photo ? (fraction) => {
          if (reply.status === "streaming" && fraction < 1) { reply.stage = `upload:${Math.round(fraction * 100)}`; this.renderStatus(reply); }
        } : undefined,
      });
      if (reply.status === "streaming") this.fail(reply, "EXPIRED");
    } catch (error) {
      if (controller.signal.aborted) {
        if (reply.status === "streaming") { reply.status = "stopped"; reply.stage = undefined; }
      } else {
        this.fail(reply, error instanceof TurnError ? error.code : "NETWORK");
      }
    } finally {
      if (this.active?.entryId === reply.id) this.active = null;
      this.save();
      if (this.state.entries.includes(reply)) this.renderEntry(reply.id);
      this.renderComposer();
    }
  }

  private fail(reply: AssistantEntry, code: string) {
    reply.status = "error";
    reply.stage = undefined;
    reply.error = errorMessage(code);
  }

  /** Applies one streamed event. Events from a stopped or superseded turn are ignored, so nothing is duplicated. */
  private onEvent(entryId: string, event: TurnEvent) {
    if (this.active?.entryId !== entryId) return;
    const reply = this.state.entries.find((entry): entry is AssistantEntry => entry.id === entryId && entry.kind === "assistant");
    if (!reply || reply.status !== "streaming") return;
    switch (event.type) {
      case "status":
        reply.stage = String(event.stage ?? "");
        this.renderStatus(reply);
        this.announce(STAGE_LABELS[reply.stage] ?? "");
        return;
      case "delta":
        reply.text += String(event.text ?? "");
        reply.stage = "writing";
        this.updateText(reply);
        return;
      case "reset_text":
        reply.text = "";
        this.updateText(reply);
        return;
      case "recommendations":
        reply.recommendations = (event.items ?? []) as Recommendation[];
        reply.focus = false;
        this.state.shown = reply.recommendations.map(({ productRef, variantRef }) => ({ productRef, variantRef }));
        this.syncCards(reply.recommendations, reply.id);
        this.save();
        this.renderAll();
        return;
      case "visualise":
        reply.visualise = event.item as Recommendation;
        this.select(reply.visualise, this.state.selected?.productRef === reply.visualise.productRef ? this.state.selected.source : "conversation");
        this.syncCards([reply.visualise], reply.id);
        this.save();
        this.renderAll();
        return;
      case "selected": {
        const item = event.item as Recommendation;
        this.select(item, event.source ?? "conversation");
        // "Show me X": the product's own card, with its real photo, whether or not it can be previewed.
        if (!reply.recommendations.some((card) => card.productRef === item.productRef)) {
          reply.recommendations = [...(reply.focus || !reply.recommendations.length ? [] : reply.recommendations), item];
          reply.focus = reply.recommendations.length === 1;
        }
        this.syncCards([item], reply.id);
        this.save();
        this.renderAll();
        return;
      }
      case "constraints":
        this.state.constraints = event.constraints ?? null;
        this.save();
        return;
      case "room":
        this.state.room = event.room;
        this.renderRoomChip();
        this.save();
        return;
      case "preferences":
        this.state.preferences = event.preferences;
        this.save();
        return;
      case "final": {
        const final = event.reply ?? {};
        // The server's sanitised message is authoritative and replaces the streamed draft.
        reply.text = String(final.message ?? reply.text);
        if (Array.isArray(final.recommendations) && final.recommendations.length) reply.recommendations = final.recommendations;
        if (final.visualise) reply.visualise = final.visualise;
        if (final.selection) this.state.selected = { productRef: final.selection.productRef, variantRef: final.selection.variantRef ?? null, source: final.selection.source ?? "conversation" };
        if (final.constraints) this.state.constraints = final.constraints;
        if (final.room) this.state.room = final.room;
        if (final.preferences) this.state.preferences = final.preferences;
        reply.status = "done";
        reply.stage = undefined;
        this.save();
        this.renderEntry(reply.id);
        this.renderRoomChip();
        this.scrollToEnd(false);
        this.announce(`Room Assistant: ${reply.text}`);
        if (!this.visible) this.context.launcher?.classList.add("has-unread");
        return;
      }
      case "error":
        this.fail(reply, String(event.code ?? "PROVIDER_UNAVAILABLE"));
        this.renderEntry(reply.id);
        return;
      case "cancelled":
        reply.status = "stopped";
        reply.stage = undefined;
        this.renderEntry(reply.id);
        return;
    }
  }

  // ---------- previews ----------

  /** Starts an AI preview for one verified card. Needs a room photo; asks for one if missing. */
  async startPreview(item: Recommendation) {
    if (!item.previewAvailable || this.config.previewsAvailable === false) return;
    // One job per card at a time: a double click never starts (or charges for) a second preview.
    if (this.state.entries.some((entry) => entry.kind === "preview" && entry.status === "generating" && entry.item.id === item.id)) return;
    if (this.attachment && !this.roomPhoto) { this.roomPhoto = this.attachment; this.attachment = null; this.renderComposer(); }
    if (!this.roomPhoto) {
      this.pendingPreview = item;
      this.composerError = "";
      this.addNotice("Add a room photo to create the preview. Photos aren't kept after the page reloads.");
      this.openPicker("upload");
      return;
    }
    if (this.leadNeeded()) return this.openLeadForm(item, false);
    const entry: PreviewEntry = { id: uid(), kind: "preview", item, status: "generating", stage: "checking_photo", at: Date.now() };
    this.state.entries.push(entry);
    this.save();
    this.renderAll();
    this.scrollToEnd(true);
    const controller = new AbortController();
    this.previews.set(entry.id, controller);
    try {
      const { url, acknowledge } = await generatePreview({
        item,
        photo: this.roomPhoto.blob,
        visitor: storedVisitorId(),
        signal: controller.signal,
        onStage: (stage) => { entry.stage = stage; this.renderEntry(entry.id); },
        leadDone: this.leadDoneFlag(),
      });
      if (controller.signal.aborted || !this.state.entries.includes(entry)) { URL.revokeObjectURL(url); return; }
      this.previewUrls.set(entry.id, url);
      entry.status = "ready";
      entry.stage = undefined;
      this.renderEntry(entry.id);
      // The image is now on screen: acknowledge delivery and tag the basket, exactly as the product popup does.
      acknowledge();
      void tagBasket(item.productId);
      this.state.previewsDelivered += 1;
      this.announce(`Your AI room preview of the ${item.title} is ready.`);
      // "After" timing: the email is asked once, after the first preview, as on the product page.
      const lead = this.config.lead;
      if (lead && lead.mode !== "off" && lead.timing === "after" && !this.state.lead.done) this.openLeadForm(item, true);
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof PreviewError ? error.code : (error as any)?.code ?? "FAILED";
      entry.status = "failed";
      entry.stage = undefined;
      if (code === "LEAD_REQUIRED") {
        // The store needs an email first: replace this attempt with the in-chat email step (never a repeated warning).
        this.state.entries = this.state.entries.filter((candidate) => candidate !== entry);
        this.state.lead.done = false;
        this.openLeadForm(item, false);
        return;
      }
      entry.error = previewErrorMessage(code);
      this.renderEntry(entry.id);
    } finally {
      this.previews.delete(entry.id);
      this.save();
      // Re-enable the card's preview button (it shows "Creating preview…" while the job runs).
      this.renderAll();
    }
  }

  private abortAll() {
    this.active?.controller.abort();
    this.active = null;
    for (const controller of this.previews.values()) controller.abort();
    this.previews.clear();
  }

  private addNotice(text: string) {
    // The same notice is never stacked: once shown recently, it is not added again.
    if (this.state.entries.slice(-4).some((entry) => entry.kind === "notice" && entry.text === text)) {
      this.scrollToEnd(true);
      return;
    }
    this.state.entries.push({ id: uid(), kind: "notice", text, at: Date.now() });
    this.save();
    this.renderAll();
    this.scrollToEnd(true);
  }

  // ---------- attachments ----------

  private openPicker(kind: "upload" | "camera") {
    this.menu = "none";
    this.renderMenus();
    this.root?.querySelector<HTMLInputElement>(`[data-ta-file="${kind}"]`)?.click();
  }

  async attach(file: File) {
    this.preparing = true;
    this.composerError = "";
    this.renderComposer();
    try {
      const prepared = await (this.context.preparePhoto ?? prepareRoomPhoto)(file);
      if (this.attachment && this.attachment.url !== this.roomPhoto?.url) URL.revokeObjectURL(this.attachment.url);
      this.attachment = prepared;
    } catch (error) {
      this.composerError = error instanceof PhotoError ? error.message : "We couldn't read that photo. Please try another one.";
    } finally {
      this.preparing = false;
      this.renderComposer();
    }
    if (!this.attachment) return;
    const textarea = this.textarea();
    if (textarea && !textarea.value.trim()) {
      if (this.pendingIntent === "recommend") textarea.value = "Which furniture from this store would suit this room?";
      if (this.pendingIntent === "visualise") textarea.value = this.context.productId ? "Show this product in my room." : "Show me how a product would look in this room.";
      this.autosize();
    }
    textarea?.focus();
    if (this.pendingPreview) {
      const item = this.pendingPreview;
      this.pendingPreview = null;
      void this.startPreview(item);
    }
  }

  removeAttachment() {
    if (this.attachment && this.attachment.url !== this.roomPhoto?.url) URL.revokeObjectURL(this.attachment.url);
    this.attachment = null;
    this.composerError = "";
    this.renderComposer();
  }

  // ---------- welcome actions ----------

  private welcomeAction(action: string) {
    if (action === "visualise") {
      this.pendingIntent = "visualise";
      if (this.context.openCurrentPreview && !this.roomPhoto && !this.attachment) {
        this.addNotice("Add a room photo here and I'll check whether this exact option can be previewed, or use “Use product preview” to open the product's own preview.");
      } else if (!this.context.productId) {
        this.addNotice("Add a room photo, then tell me which piece you'd like to see, for example “Show the Aria bed in cream in my room”.");
      }
      if (!this.roomPhoto && !this.attachment) this.openPicker("upload");
      else { const t = this.textarea(); if (t) { t.value = this.context.productId ? "Show this product in my room." : "Show me how a product would look in my room."; t.focus(); } }
      return;
    }
    if (action === "recommend") {
      this.pendingIntent = "recommend";
      if (!this.roomPhoto && !this.attachment) this.openPicker("upload");
      else { const t = this.textarea(); if (t) { t.value = "Which furniture from this store would suit my room?"; t.focus(); } }
      return;
    }
    if (action === "ask") this.textarea()?.focus();
  }

  // ---------- events ----------

  private onClick(event: Event) {
    const target = event.target as HTMLElement;
    const element = target.closest<HTMLElement>("[data-ta]");
    if (!element) {
      if (target.classList.contains("tryora-assistant__backdrop")) this.minimise();
      if (this.menu !== "none" && !target.closest(".tryora-assistant__menu")) { this.menu = "none"; this.renderMenus(); }
      return;
    }
    const action = element.dataset.ta!;
    const id = element.dataset.id ?? "";
    switch (action) {
      case "close": return this.close();
      case "minimise": return this.minimise();
      case "view": return this.toggleFullscreen();
      case "more": this.menu = this.menu === "more" ? "none" : "more"; return this.renderMenus();
      case "attach": this.menu = this.menu === "attach" ? "none" : "attach"; return this.renderMenus();
      case "upload": return this.openPicker("upload");
      case "camera": return this.openPicker("camera");
      case "remove-photo": return this.removeAttachment();
      case "new-chat": return this.newChat();
      case "clear": return this.clearConversation();
      case "forget-room": return this.forgetRoom();
      case "send": return void this.send();
      case "stop": return this.stop();
      case "retry": return void this.retry(id);
      case "suggest": return void this.send(element.dataset.text ?? "");
      case "welcome": return this.welcomeAction(element.dataset.action ?? "");
      case "product-preview":
        this.minimise();
        return this.context.openCurrentPreview?.();
      case "preview": {
        const item = this.findItem(id);
        if (item) void this.startPreview(item);
        return;
      }
      case "cancel-preview": return this.previews.get(id)?.abort();
      case "options": return void this.toggleOptions(element.dataset.card ?? "");
      case "select": return this.selectCard(element.dataset.card ?? "");
      case "opt": return this.chooseOption(element.dataset.card ?? "", element.dataset.attr ?? "", element.dataset.value ?? "");
      case "lead-submit": return void this.submitLead(id);
      case "lead-skip": return this.skipLead(id);
      case "another": {
        const item = this.findItem(id);
        const textarea = this.textarea();
        if (item && textarea) { textarea.value = `Show another available option of the ${item.title}.`; this.autosize(); textarea.focus(); }
        return;
      }
    }
  }

  private findItem(id: string): Recommendation | null {
    for (const entry of [...this.state.entries].reverse()) {
      if (entry.kind === "assistant") {
        const found = [...entry.recommendations, ...(entry.visualise ? [entry.visualise] : [])].find((item) => item.id === id);
        if (found) return found;
      }
      if (entry.kind === "preview" && entry.item.id === id) return entry.item;
    }
    return null;
  }

  private async onChange(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.dataset.taFile) return;
    const file = input.files?.[0];
    input.value = "";
    if (file) await this.attach(file);
  }

  private onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.menu !== "none") { this.menu = "none"; this.renderMenus(); return; }
      return this.minimise();
    }
    if (event.key === "Enter" && !event.shiftKey && target.matches("textarea")) {
      event.preventDefault();
      if (!this.active) void this.send();
      return;
    }
    // Only fullscreen is modal; the side panel lets keyboard users continue into the page.
    if (event.key !== "Tab" || this.state.ui.view !== "fullscreen" || !this.root) return;
    const focusable = [...this.root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], textarea, input:not([type=file])")]
      .filter((element) => !element.closest("[hidden]"));
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  // ---------- rendering ----------

  private mount() {
    const root = document.createElement("div");
    root.className = "tryora-assistant";
    root.hidden = true;
    root.dataset.view = this.state.ui.view;
    root.dataset.position = this.config.launcher.position;
    root.style.setProperty("--ta-accent", this.config.launcher.colour);
    root.innerHTML = `<div class="tryora-assistant__backdrop"></div>
      <section class="tryora-assistant__panel" role="dialog" aria-labelledby="tryora-assistant-title" aria-describedby="tryora-assistant-subtitle">
        <header class="tryora-assistant__header">
          <span class="tryora-assistant__avatar">${ICONS.spark}</span>
          <div class="tryora-assistant__heading">
            <h2 id="tryora-assistant-title">Room Assistant</h2>
            <p id="tryora-assistant-subtitle">Ask about products or your room</p>
          </div>
          <div class="tryora-assistant__actions">
            <button type="button" class="tryora-assistant__icon" data-ta="more" aria-haspopup="menu" aria-expanded="false" aria-label="Conversation options">${ICONS.more}</button>
            <button type="button" class="tryora-assistant__icon" data-ta="minimise" aria-label="Minimise">${ICONS.minimise}</button>
            <button type="button" class="tryora-assistant__icon tryora-assistant__view" data-ta="view"></button>
            <button type="button" class="tryora-assistant__icon" data-ta="close" aria-label="Close Room Assistant">${ICONS.close}</button>
          </div>
          <div class="tryora-assistant__menu tryora-assistant__menu--more" role="menu" hidden>
            <button type="button" role="menuitem" data-ta="new-chat">New chat</button>
            <button type="button" role="menuitem" data-ta="clear">Clear conversation</button>
            <button type="button" role="menuitem" data-ta="forget-room">Forget room</button>
          </div>
        </header>
        <div class="tryora-assistant__scroll" data-ta-scroll></div>
        <div class="tryora-assistant__composer">
          <div data-ta-room></div>
          <div class="tryora-assistant__attachment" data-ta-attachment hidden></div>
          <p class="tryora-assistant__composer-error" role="alert" data-ta-error hidden></p>
          <div class="tryora-assistant__row">
            <div class="tryora-assistant__attach-wrap">
              <button type="button" class="tryora-assistant__attach" data-ta="attach" aria-haspopup="menu" aria-expanded="false" aria-label="Add a room photo">${ICONS.plus}</button>
              <div class="tryora-assistant__menu tryora-assistant__menu--attach" role="menu" hidden>
                <button type="button" role="menuitem" data-ta="upload">${ICONS.photo}<span>Upload photo</span></button>
                <button type="button" role="menuitem" data-ta="camera" data-ta-camera>${ICONS.camera}<span>Take photo</span></button>
              </div>
            </div>
            <label class="tryora-assistant__sr" for="tryora-assistant-input">Message the Room Assistant</label>
            <textarea id="tryora-assistant-input" name="assistant-message" rows="1" maxlength="800" placeholder="Ask about products or your room…"></textarea>
            <button type="button" class="tryora-assistant__send" data-ta="send" aria-label="Send message">${ICONS.send}</button>
          </div>
          <p class="tryora-assistant__fineprint">AI can make mistakes. Check product details before you buy.</p>
          <input type="file" hidden data-ta-file="upload" accept="image/jpeg,image/png,image/webp,image/heic,image/heif">
          <input type="file" hidden data-ta-file="camera" accept="image/*" capture="environment">
        </div>
        <p class="tryora-assistant__sr" aria-live="polite" data-ta-live></p>
      </section>`;
    root.addEventListener("click", (event) => this.onClick(event));
    root.addEventListener("change", (event) => void this.onChange(event));
    root.addEventListener("keydown", (event) => this.onKey(event));
    root.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.matches("textarea")) this.autosize();
      if (target.name?.startsWith("ta-lead-") && target.dataset.entry) this.updateLeadDraft(target);
    });
    root.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.name === "ta-lead-marketing" && target.dataset.entry) this.updateLeadDraft(target);
    });
    // Image load and error events do not bubble; listen in the capture phase.
    root.addEventListener("load", (event) => {
      const thumb = (event.target as HTMLElement).closest?.(".tryora-assistant__thumb") as HTMLElement | null;
      if (thumb) thumb.dataset.state = "loaded";
    }, true);
    root.addEventListener("error", (event) => {
      const image = event.target as HTMLElement;
      const thumb = image.closest?.(".tryora-assistant__thumb") as HTMLElement | null;
      if (!thumb || image.tagName !== "IMG") return;
      thumb.dataset.state = "error";
      thumb.setAttribute("role", "img");
      thumb.setAttribute("aria-label", `Image unavailable: ${image.getAttribute("alt") ?? ""}`);
      thumb.innerHTML = "<span>Image unavailable</span>";
    }, true);
    document.body.appendChild(root);
    this.root = root;
    if (!coarsePointer()) root.querySelector("[data-ta-camera]")?.setAttribute("hidden", "");
  }

  private textarea() { return this.root?.querySelector<HTMLTextAreaElement>("textarea") ?? null; }
  private scroller() { return this.root?.querySelector<HTMLElement>("[data-ta-scroll]") ?? null; }

  private autosize() {
    const textarea = this.textarea();
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(140, textarea.scrollHeight || 0) || 44}px`;
  }

  private renderAll() {
    if (!this.root) return;
    this.renderHeader();
    const scroll = this.scroller()!;
    scroll.innerHTML = this.state.entries.length ? this.state.entries.map((entry) => this.entryHtml(entry)).join("") : this.welcomeHtml();
    this.renderComposer();
    this.renderRoomChip();
    this.renderMenus();
  }

  private renderHeader() {
    const button = this.root?.querySelector<HTMLElement>("[data-ta='view']");
    if (!button) return;
    const full = this.state.ui.view === "fullscreen";
    button.innerHTML = full ? ICONS.restore : ICONS.expand;
    button.setAttribute("aria-label", full ? "Restore side panel" : "Expand to fullscreen");
    button.setAttribute("aria-pressed", String(full));
    this.root!.querySelector(".tryora-assistant__panel")!.setAttribute("aria-modal", String(full));
  }

  private renderMenus() {
    if (!this.root) return;
    const more = this.root.querySelector<HTMLElement>(".tryora-assistant__menu--more")!;
    const attach = this.root.querySelector<HTMLElement>(".tryora-assistant__menu--attach")!;
    more.hidden = this.menu !== "more";
    attach.hidden = this.menu !== "attach";
    this.root.querySelector("[data-ta='more']")!.setAttribute("aria-expanded", String(this.menu === "more"));
    this.root.querySelector("[data-ta='attach']")!.setAttribute("aria-expanded", String(this.menu === "attach"));
    const forget = more.querySelector<HTMLButtonElement>("[data-ta='forget-room']")!;
    forget.disabled = !this.state.room && !this.roomPhoto;
  }

  private renderComposer() {
    if (!this.root) return;
    const box = this.root.querySelector<HTMLElement>("[data-ta-attachment]")!;
    if (this.preparing) {
      box.hidden = false;
      box.innerHTML = `<span class="tryora-assistant__spinner" aria-hidden="true"></span><span>Preparing photo…</span>`;
    } else if (this.attachment) {
      box.hidden = false;
      box.innerHTML = `<img src="${escapeHtml(this.attachment.url)}" alt="Selected room photo">
        <span class="tryora-assistant__attachment-name">Room photo ready</span>
        <button type="button" data-ta="upload" class="tryora-assistant__chip-button">Replace</button>
        <button type="button" data-ta="remove-photo" class="tryora-assistant__chip-button" aria-label="Remove photo">Remove</button>`;
    } else {
      box.hidden = true;
      box.innerHTML = "";
    }
    const error = this.root.querySelector<HTMLElement>("[data-ta-error]")!;
    error.hidden = !this.composerError;
    error.textContent = this.composerError;
    const send = this.root.querySelector<HTMLButtonElement>(".tryora-assistant__send")!;
    const busy = !!this.active;
    send.dataset.ta = busy ? "stop" : "send";
    send.innerHTML = busy ? ICONS.stop : ICONS.send;
    send.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
    send.disabled = this.preparing;
    this.root.querySelector<HTMLButtonElement>("[data-ta='attach']")!.disabled = busy || this.preparing;
  }

  private renderRoomChip() {
    const box = this.root?.querySelector<HTMLElement>("[data-ta-room]");
    if (!box) return;
    const room = this.state.room;
    if (!room && !this.roomPhoto) { box.innerHTML = ""; return; }
    const summary = room ? [room.style, ...room.colours.slice(0, 2)].filter(Boolean).join(", ") : "photo added";
    box.innerHTML = `<p class="tryora-assistant__room-chip">${ICONS.room}<span>Using your room: ${escapeHtml(summary || "photo notes")}</span>
      <button type="button" class="tryora-assistant__link" data-ta="forget-room">Forget room</button></p>`;
  }

  private renderEntry(id: string) {
    const entry = this.state.entries.find((candidate) => candidate.id === id);
    const node = this.root?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`);
    if (!entry || !node) return;
    const near = this.nearBottom();
    node.outerHTML = this.entryHtml(entry);
    if (near) this.scrollToEnd(false);
  }

  private renderStatus(entry: AssistantEntry) {
    const node = this.root?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(entry.id)}"] [data-ta-status]`);
    if (node) node.textContent = this.stageLabel(entry.stage);
    else this.renderEntry(entry.id);
  }

  private updateText(entry: AssistantEntry) {
    const node = this.root?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(entry.id)}"] [data-ta-text]`);
    if (!node) return this.renderEntry(entry.id);
    const near = this.nearBottom();
    node.innerHTML = formatText(entry.text);
    node.closest(".tryora-assistant__bubble")?.classList.toggle("is-empty", !entry.text);
    const status = this.root?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(entry.id)}"] [data-ta-status]`);
    if (status) status.hidden = !!entry.text;
    if (near) this.scrollToEnd(false);
  }

  private stageLabel(stage?: string) {
    if (stage?.startsWith("upload:")) return `Uploading photo… ${stage.slice(7)}%`;
    return STAGE_LABELS[stage ?? ""] ?? "Thinking…";
  }

  private welcomeHtml() {
    const productPreview = this.context.openCurrentPreview
      ? `<button type="button" class="tryora-assistant__link tryora-assistant__welcome-link" data-ta="product-preview">Use product preview instead</button>` : "";
    return `<div class="tryora-assistant__welcome">
      <span class="tryora-assistant__welcome-icon">${ICONS.spark}</span>
      <h3>${escapeHtml(this.config.greeting)}</h3>
      <p>I can help you find furniture from this store and see it in your room.</p>
      <div class="tryora-assistant__actions-grid">
        <button type="button" class="tryora-assistant__action" data-ta="welcome" data-action="visualise">
          <span class="tryora-assistant__action-icon">${ICONS.room}</span>
          <span><strong>Visualise in my room</strong><small>Upload a room photo and preview a store product</small></span>
        </button>
        <button type="button" class="tryora-assistant__action" data-ta="welcome" data-action="recommend">
          <span class="tryora-assistant__action-icon">${ICONS.sofa}</span>
          <span><strong>Find furniture for my room</strong><small>Get ideas that suit your room's style and colours</small></span>
        </button>
        <button type="button" class="tryora-assistant__action" data-ta="welcome" data-action="ask">
          <span class="tryora-assistant__action-icon">${ICONS.chat}</span>
          <span><strong>Ask about products</strong><small>Fabrics, sizes, prices, delivery and returns</small></span>
        </button>
      </div>
      ${productPreview}
      <div class="tryora-assistant__suggestions" aria-label="Suggested questions">
        ${SUGGESTIONS.map((text) => `<button type="button" class="tryora-assistant__suggestion" data-ta="suggest" data-text="${escapeHtml(text)}">${escapeHtml(text)}</button>`).join("")}
      </div>
    </div>`;
  }

  private entryHtml(entry: Entry): string {
    const id = escapeHtml(entry.id);
    if (entry.kind === "notice") return `<div class="tryora-assistant__notice" data-entry="${id}">${escapeHtml(entry.text)}</div>`;
    if (entry.kind === "user") {
      const url = this.photoUrls.get(entry.id);
      const photo = entry.photo
        ? url ? `<img class="tryora-assistant__user-photo" src="${escapeHtml(url)}" alt="Your room photo">`
          : `<span class="tryora-assistant__photo-note">${ICONS.photo} Room photo (not kept after the page reloads)</span>`
        : "";
      return `<div class="tryora-assistant__message tryora-assistant__message--user" data-entry="${id}">${photo}<div class="tryora-assistant__bubble"><p>${escapeHtml(entry.text)}</p></div></div>`;
    }
    if (entry.kind === "preview") return this.previewHtml(entry);
    if (entry.kind === "lead") return this.leadHtml(entry);
    const streaming = entry.status === "streaming";
    const status = streaming ? `<p class="tryora-assistant__status" data-ta-status ${entry.text ? "hidden" : ""}><span class="tryora-assistant__dots" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(this.stageLabel(entry.stage))}</p>` : "";
    const error = entry.status === "error" || entry.status === "stopped"
      ? `<div class="tryora-assistant__failed" role="${entry.status === "error" ? "alert" : "status"}"><span>${escapeHtml(entry.status === "stopped" ? "Stopped." : entry.error ?? errorMessage(""))}</span>
          <button type="button" class="tryora-assistant__chip-button" data-ta="retry" data-id="${id}">Retry</button></div>` : "";
    const text = entry.text || streaming ? `<div class="tryora-assistant__bubble ${entry.text ? "" : "is-empty"}" aria-busy="${streaming}">${status}<div class="tryora-assistant__text" data-ta-text>${formatText(entry.text)}</div></div>` : "";
    return `<div class="tryora-assistant__message tryora-assistant__message--assistant" data-entry="${id}">
      ${text}${error}
      ${entry.recommendations.length ? `<div class="tryora-assistant__cards">${entry.recommendations.map((item, index) => this.cardHtml(item, index, entry.id)).join("")}</div>` : ""}
      ${entry.visualise ? this.visualiseHtml(entry.visualise) : ""}
    </div>`;
  }

  private priceHtml(item: Recommendation) {
    const price = item.maxPrice ? `${money(item.price, item.currencyCode)} – ${money(item.maxPrice, item.currencyCode)}` : money(item.price, item.currencyCode);
    return price ? `<strong class="tryora-assistant__price">${escapeHtml(price)}</strong>` : "";
  }

  private badgesHtml(item: Recommendation) {
    const buy = `<span class="tryora-assistant__badge ${item.purchaseAvailable ? "is-yes" : "is-no"}">${item.purchaseAvailable ? "Available to buy" : "Currently sold out"}</span>`;
    const preview = item.previewAvailable ? `<span class="tryora-assistant__badge is-yes">AI room preview available</span>`
      : item.previewStatus === "product_page" || item.previewStatus === "choose_options"
        ? `<span class="tryora-assistant__badge">Choose options on the product page to check AI preview</span>`
        : `<span class="tryora-assistant__badge">AI room preview not available</span>`;
    return `${buy}${preview}`;
  }

  /**
   * A real Shopify thumbnail with loading and error states. A general product photo shown for a specific option is
   * labelled, so it is never mistaken for that option's appearance. Missing images show text, never stock art.
   */
  private thumbHtml(src: string | null | undefined, alt: string, note = "") {
    if (!src) return `<div class="tryora-assistant__thumb is-missing" role="img" aria-label="${escapeHtml(`No image available for ${alt}`)}"><span>No image</span></div>`;
    return `<div class="tryora-assistant__thumb" data-state="loading">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">
      ${note ? `<span class="tryora-assistant__thumb-note">${escapeHtml(note)}</span>` : ""}
    </div>`;
  }

  /** Applies store-wide conditions (no preview credits left) to a card at render time. */
  private effective(item: Recommendation): Recommendation {
    if (item.previewAvailable && this.config.previewsAvailable === false) {
      return { ...item, previewAvailable: false, previewStatus: "unavailable", previewReason: "New AI previews are temporarily unavailable." };
    }
    return item;
  }

  private isSelected(item: Recommendation) {
    const selected = this.state.selected;
    return !!selected && selected.productRef === item.productRef && (selected.variantRef ?? null) === (item.variantRef ?? null);
  }

  private cardHtml(raw: Recommendation, index: number, entryId = "") {
    const item = this.effective(raw);
    const key = `${entryId}:${index}`;
    const options = Object.entries(item.options).filter(([name, value]) => !isDefaultTitle(name, value))
      .map(([name, value]) => `<span class="tryora-assistant__tag">${escapeHtml(name)}: ${escapeHtml(value)}</span>`).join("");
    const id = escapeHtml(item.id);
    // A single-variant product's photo shows its only configuration; label it only where options exist (or are unknown).
    const generalPhoto = item.imageSource === "product" && !!item.variantRef && item.hasOptions !== false;
    const note = generalPhoto ? "Product photo" : item.imageSource === "reference" ? "Preview reference" : "";
    const choose = !!item.hasOptions && !item.variantRef && item.previewStatus === "choose_options";
    const unavailable = !item.previewAvailable && !choose && item.previewStatus !== "not_configured";
    const reason = item.previewReason ?? (item.previewStatus === "product_page"
      ? "Choose this product's options on its product page to preview it."
      : !item.purchaseAvailable ? "This option is sold out, so it can't be previewed." : "This exact option isn't approved for AI room preview.");
    const panel = this.cardOptions.get(key);
    const optionsButton = item.hasOptions
      ? `<button type="button" class="tryora-assistant__secondary" data-ta="options" data-card="${escapeHtml(key)}" aria-expanded="${!!panel}">${item.variantRef ? "Change options" : "Choose options"}</button>` : "";
    const selected = this.isSelected(raw);
    const focus = this.state.entries.some((entry) => entry.kind === "assistant" && entry.id === entryId && entry.focus);
    const label = focus ? "Selected product" : `Option ${index + 1}${selected ? " · Selected" : ""}`;
    const selectButton = selected || focus ? ""
      : `<button type="button" class="tryora-assistant__secondary" data-ta="select" data-card="${escapeHtml(key)}" aria-label="Select ${escapeHtml(item.title)}">Select</button>`;
    return `<article class="tryora-assistant__card${selected ? " is-selected" : ""}" data-card="${escapeHtml(key)}" aria-current="${selected}">
      ${this.thumbHtml(item.image, item.imageAlt || item.title, note)}
      <div class="tryora-assistant__card-body">
        <span class="tryora-assistant__eyebrow">${label}</span>
        <h4>${escapeHtml(item.title)}</h4>
        ${options ? `<div class="tryora-assistant__tags">${options}</div>` : ""}
        ${this.priceHtml(item)}
        <div class="tryora-assistant__tags">${this.badgesHtml(item)}</div>
        ${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ""}
        ${generalPhoto ? `<p class="tryora-assistant__image-note">Photo shows the product; your selected option may look different.</p>` : ""}
        ${panel ? this.optionsPanelHtml(key, panel) : ""}
        <div class="tryora-assistant__card-actions">
          <a class="tryora-assistant__secondary" href="${escapeHtml(item.url)}">View product</a>
          ${selectButton}
          ${optionsButton}
          ${item.previewAvailable ? `<button type="button" class="tryora-assistant__primary" data-ta="preview" data-id="${id}" ${this.generating(item) ? "disabled" : ""}>${this.generating(item) ? "Creating preview…" : "See it in my room"}</button>`
            : unavailable ? `<button type="button" class="tryora-assistant__primary" disabled aria-describedby="ta-why-${id}">See it in my room</button>` : ""}
        </div>
        ${unavailable ? `<p class="tryora-assistant__image-note" id="ta-why-${id}">${escapeHtml(reason)}</p>` : ""}
        ${choose && !panel ? `<p class="tryora-assistant__image-note">Choose options to check price, stock and AI room preview.</p>` : ""}
      </div>
    </article>`;
  }

  private visualiseHtml(item: Recommendation) {
    const options = Object.values(item.options).join(" / ");
    // Show the exact approved reference the preview will be generated from, not a general product photo.
    const reference = item.referenceImage ?? (item.imageSource === "variant" || item.imageSource === "reference" ? item.image : null);
    return `<div class="tryora-assistant__visualise">
      ${this.thumbHtml(reference, `${item.title}${options ? `, ${options}` : ""}`, reference ? "Preview reference" : "")}
      <div>
        <span class="tryora-assistant__eyebrow">AI room preview</span>
        <h4>${escapeHtml(item.title)}</h4>
        ${options ? `<p>${escapeHtml(options)}</p>` : ""}
        <p class="tryora-assistant__fineprint">${this.roomPhoto ? "Uses your room photo." : "You'll be asked for a room photo."} Tryora places the item automatically.</p>
        <button type="button" class="tryora-assistant__primary" data-ta="preview" data-id="${escapeHtml(item.id)}" ${this.generating(item) ? "disabled" : ""}>${this.generating(item) ? "Creating preview…" : this.roomPhoto ? "Generate preview" : "Add room photo and preview"}</button>
      </div>
    </div>`;
  }

  private previewHtml(entry: PreviewEntry) {
    const id = escapeHtml(entry.id);
    const options = Object.values(entry.item.options).join(" / ");
    const label = `${entry.item.title}${options ? ` · ${options}` : ""}`;
    if (entry.status === "generating") {
      return `<div class="tryora-assistant__message tryora-assistant__message--preview" data-entry="${id}">
        <div class="tryora-assistant__preview is-loading"><span class="tryora-assistant__spinner" aria-hidden="true"></span>
          <div><strong>${escapeHtml(label)}</strong><p data-ta-status>${escapeHtml(PREVIEW_STAGES[entry.stage ?? ""] ?? "Working on your preview…")}</p></div>
          <button type="button" class="tryora-assistant__chip-button" data-ta="cancel-preview" data-id="${id}">Cancel</button></div></div>`;
    }
    const url = this.previewUrls.get(entry.id);
    if (entry.status === "ready" && url) {
      const file = `${label} - in my room.jpg`.replace(/[\\/:*?"<>|]/g, "");
      return `<div class="tryora-assistant__message tryora-assistant__message--preview" data-entry="${id}">
        <figure class="tryora-assistant__preview">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(`${label}, shown in your room`)}">
          <figcaption><strong>${escapeHtml(label)}</strong>
            <span>AI-generated visualisation for illustration only. Colour, scale and placement may differ; check dimensions before ordering.</span></figcaption>
          <div class="tryora-assistant__card-actions">
            <a class="tryora-assistant__primary" href="${escapeHtml(url)}" download="${escapeHtml(file)}">Download</a>
            <a class="tryora-assistant__secondary" href="${escapeHtml(entry.item.url)}">View product</a>
            <button type="button" class="tryora-assistant__secondary" data-ta="another" data-id="${escapeHtml(entry.item.id)}">Try another option</button>
          </div>
        </figure></div>`;
    }
    const message = entry.status === "ready" ? "This preview was shown earlier; images are not kept after the page reloads." : entry.error ?? previewErrorMessage("");
    return `<div class="tryora-assistant__message tryora-assistant__message--preview" data-entry="${id}">
      <div class="tryora-assistant__failed" role="${entry.status === "failed" ? "alert" : "status"}"><span>${escapeHtml(message)}</span>
      ${entry.handoff ? `<a class="tryora-assistant__chip-button" href="${escapeHtml(entry.handoff)}">Continue on product page</a>`
        : entry.status === "failed" ? `<button type="button" class="tryora-assistant__chip-button" data-ta="preview" data-id="${escapeHtml(entry.item.id)}">Try again</button>` : ""}</div></div>`;
  }

  // ---------- email step (the merchant's lead capture) ----------

  /** True when the merchant's email step must be completed before the next preview, mirroring the popup's rules. */
  private leadNeeded(): boolean {
    const lead = this.config.lead;
    if (this.state.lead.done || !lead || lead.mode === "off") return false;
    // "After" timing lets the first preview through and asks afterwards, as on the product page.
    return !(lead.timing === "after" && this.state.previewsDelivered === 0);
  }

  /** The leadDone flag the preview endpoint expects. Without lead settings the server decides (LEAD_REQUIRED). */
  private leadDoneFlag(): "0" | "1" {
    if (this.state.lead.done) return "1";
    return this.config.lead && !this.leadNeeded() ? "1" : "0";
  }

  /** Shows the email step once; a second request reuses the open form instead of stacking warnings. */
  private openLeadForm(item: Recommendation, after: boolean) {
    const open = this.state.entries.find((entry): entry is LeadEntry => entry.kind === "lead" && (entry.status === "open" || entry.status === "sending"));
    if (open) {
      if (!after) { open.item = item; open.after = false; }
    } else {
      this.state.entries.push({ id: uid(), kind: "lead", item, status: "open", after, at: Date.now() });
    }
    this.save();
    this.renderAll();
    this.scrollToEnd(true);
    this.root?.querySelector<HTMLInputElement>('.tryora-assistant__lead input[name="ta-lead-email"]')?.focus();
  }

  private updateLeadDraft(input: HTMLInputElement) {
    const id = input.dataset.entry!;
    const draft = this.leadDrafts.get(id) ?? { email: "", firstName: "", marketing: false };
    if (input.name === "ta-lead-email") draft.email = input.value.slice(0, 254);
    if (input.name === "ta-lead-first") draft.firstName = input.value.slice(0, 80);
    if (input.name === "ta-lead-marketing") draft.marketing = input.checked;
    this.leadDrafts.set(id, draft);
  }

  /** Sends the email through the existing lead endpoint (server-validated), then continues the pending preview. */
  async submitLead(id: string) {
    const entry = this.state.entries.find((candidate): candidate is LeadEntry => candidate.id === id && candidate.kind === "lead");
    if (!entry || entry.status === "sending" || entry.status === "done") return;
    const draft = this.leadDrafts.get(id) ?? { email: "", firstName: "", marketing: false };
    if (!EMAIL.test(draft.email.trim())) {
      entry.error = "Please enter a valid email address.";
      this.renderEntry(id);
      this.root?.querySelector<HTMLInputElement>(`[data-entry="${CSS.escape(id)}"] input[name="ta-lead-email"]`)?.focus();
      return;
    }
    entry.status = "sending";
    entry.error = undefined;
    this.renderEntry(id);
    const form = new FormData();
    form.set("email", draft.email.trim());
    form.set("firstName", draft.firstName.trim());
    form.set("marketing", this.config.lead?.showOptIn && draft.marketing ? "1" : "0");
    form.set("wording", this.config.lead?.showOptIn ? this.config.lead.optInWording : "");
    form.set("product", entry.item.productId);
    form.set("option", entry.item.optionValue ?? "");
    try {
      const response = await fetch(`${PROXY}/lead`, { method: "POST", body: form, credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error ?? "REQUEST_FAILED"), { code: body.error ?? "REQUEST_FAILED" });
    } catch (error: any) {
      entry.status = "open";
      entry.error = error?.code === "BAD_EMAIL" ? "Please enter a valid email address." : "We couldn't save your email just now. Please try again.";
      this.renderEntry(id);
      return;
    }
    this.state.lead.done = true;
    entry.status = "done";
    this.leadDrafts.delete(id);
    this.save();
    this.renderEntry(id);
    if (!entry.after) void this.startPreview(entry.item);
  }

  skipLead(id: string) {
    const entry = this.state.entries.find((candidate): candidate is LeadEntry => candidate.id === id && candidate.kind === "lead");
    if (!entry || entry.status !== "open") return;
    // Before a preview only a "skippable" store allows skipping; after one, declining simply closes the prompt.
    if (!entry.after && this.config.lead?.mode !== "skippable") return;
    if (this.config.lead?.mode === "skippable" || !entry.after) this.state.lead.done = true;
    entry.status = "skipped";
    this.leadDrafts.delete(id);
    this.save();
    this.renderEntry(id);
    if (!entry.after) void this.startPreview(entry.item);
  }

  private leadHtml(entry: LeadEntry) {
    const id = escapeHtml(entry.id);
    if (entry.status === "done" || entry.status === "skipped") {
      const text = entry.status === "skipped" ? "No problem." : entry.after ? "Thanks, you're all set." : "Thanks! Creating your preview…";
      return `<div class="tryora-assistant__notice" data-entry="${id}">${escapeHtml(text)}</div>`;
    }
    const lead = this.config.lead;
    const draft = this.leadDrafts.get(entry.id) ?? { email: "", firstName: "", marketing: false };
    const sending = entry.status === "sending";
    const canSkip = entry.after || lead?.mode === "skippable";
    return `<div class="tryora-assistant__lead" data-entry="${id}" role="group" aria-labelledby="ta-lead-${id}">
      <h4 id="ta-lead-${id}">${entry.after ? "Enter your email to keep previewing" : "Enter your email to create your preview"}</h4>
      <p>This store asks for an email for AI room previews. Your image is never emailed.</p>
      <label class="tryora-assistant__field"><span>Email address</span>
        <input type="email" name="ta-lead-email" data-entry="${id}" autocomplete="email" inputmode="email" required value="${escapeHtml(draft.email)}" ${entry.error ? 'aria-invalid="true"' : ""} ${sending ? "disabled" : ""}></label>
      <label class="tryora-assistant__field"><span>First name (optional)</span>
        <input name="ta-lead-first" data-entry="${id}" autocomplete="given-name" value="${escapeHtml(draft.firstName)}" ${sending ? "disabled" : ""}></label>
      ${lead?.showOptIn ? `<label class="tryora-assistant__check"><input type="checkbox" name="ta-lead-marketing" data-entry="${id}" ${draft.marketing ? "checked" : ""} ${sending ? "disabled" : ""}> <span>${escapeHtml(lead.optInWording)}</span></label>` : ""}
      ${entry.error ? `<p class="tryora-assistant__composer-error" role="alert">${escapeHtml(entry.error)}</p>` : ""}
      <div class="tryora-assistant__card-actions">
        <button type="button" class="tryora-assistant__primary" data-ta="lead-submit" data-id="${id}" ${sending ? "disabled" : ""}>${sending ? "Saving…" : entry.after ? "Submit" : "Continue"}</button>
        ${canSkip ? `<button type="button" class="tryora-assistant__secondary" data-ta="lead-skip" data-id="${id}" ${sending ? "disabled" : ""}>${entry.after ? "No thanks" : "Skip"}</button>` : ""}
        <a class="tryora-assistant__link" href="/policies/privacy-policy" target="_blank" rel="noopener">Privacy</a>
      </div>
    </div>`;
  }

  // ---------- in-card options (fabric, colour, size…) ----------

  private generating(item: Recommendation) {
    return this.state.entries.some((entry) => entry.kind === "preview" && entry.status === "generating" && entry.item.id === item.id);
  }

  private select(item: Recommendation, source: SelectionSource) {
    this.state.selected = { productRef: item.productRef, variantRef: item.variantRef ?? null, source };
  }

  /** The shopper chose this card: it becomes the authoritative selection the assistant must use. */
  selectCard(key: string) {
    const card = this.cardAt(key);
    if (!card) return;
    this.select(card.item, "card");
    this.save();
    this.renderAll();
    this.announce(`Selected ${card.item.title}.`);
  }

  /**
   * Older cards for the same exact variant take the newest server-verified price, stock and preview status, so two
   * cards for one product never disagree about whether it can be previewed.
   */
  private syncCards(items: Recommendation[], from?: string) {
    const fields = ["price", "maxPrice", "currencyCode", "purchaseAvailable", "previewAvailable", "previewStatus", "previewReason", "optionValue", "referenceImage"] as const;
    for (const item of items) {
      for (const entry of this.state.entries) {
        if (entry.kind !== "assistant" || entry.id === from) continue;
        entry.recommendations = entry.recommendations.map((card) => card !== item && card.productRef === item.productRef && (card.variantRef ?? null) === (item.variantRef ?? null)
          ? { ...card, ...Object.fromEntries(fields.map((field) => [field, item[field]])) } : card);
      }
    }
  }

  private cardAt(key: string): { entry: AssistantEntry; index: number; item: Recommendation } | null {
    const split = key.lastIndexOf(":");
    const entryId = key.slice(0, split);
    const index = Number(key.slice(split + 1));
    const entry = this.state.entries.find((candidate): candidate is AssistantEntry => candidate.id === entryId && candidate.kind === "assistant");
    const item = entry?.recommendations[index];
    return entry && item ? { entry, index, item } : null;
  }

  /** Opens or closes a card's option selector, loading the product's real options once per product. */
  async toggleOptions(key: string) {
    const card = this.cardAt(key);
    if (!card) return;
    if (this.cardOptions.has(key)) {
      this.cardOptions.delete(key);
      return this.renderEntry(card.entry.id);
    }
    const cached = this.optionsCache.get(card.item.productId);
    const panel: CardOptionsState = { productId: card.item.productId, data: cached ?? null, selections: cached ? selectionsFor(cached, card.item.variantRef) : {}, loading: !cached, error: "" };
    this.cardOptions.set(key, panel);
    this.renderEntry(card.entry.id);
    if (cached) return;
    try {
      const response = await fetch(`${PROXY}/assistant/options?product=${encodeURIComponent(card.item.productId)}&visitor=${encodeURIComponent(storedVisitorId())}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.variants)) throw new Error(body.error ?? "REQUEST_FAILED");
      this.optionsCache.set(card.item.productId, body as ProductOptions);
      panel.data = body as ProductOptions;
      panel.selections = selectionsFor(panel.data, card.item.variantRef);
    } catch {
      panel.error = "Options couldn't be loaded just now. Please try again.";
    } finally {
      panel.loading = false;
      if (this.cardOptions.get(key) === panel) this.renderEntry(card.entry.id);
    }
  }

  /** Applies one option choice; when the choices identify exactly one variant, the card becomes that variant. */
  chooseOption(key: string, attribute: string, value: string) {
    const panel = this.cardOptions.get(key);
    const card = this.cardAt(key);
    if (!panel?.data || !card) return;
    const data = panel.data;
    panel.selections = { ...panel.selections, [attribute]: value };
    // Drop earlier choices that no variant combines with this one (e.g. a colour from another fabric family).
    for (const other of data.attributes) {
      if (other.name === attribute || panel.selections[other.name] === undefined) continue;
      const compatible = data.variants.some((variant) => Object.entries(panel.selections).every(([name, chosen]) => variant.values[name] === chosen));
      if (!compatible) delete panel.selections[other.name];
    }
    const variant = resolveVariant(data, panel.selections);
    if (variant) {
      const updated = cardForVariant(card.item, data, variant, this.config.previewsAvailable !== false);
      const previous = card.item;
      card.entry.recommendations[card.index] = updated;
      this.state.shown = this.state.shown.map((ref) => ref.productRef === previous.productRef && ref.variantRef === previous.variantRef
        ? { productRef: updated.productRef, variantRef: updated.variantRef } : ref);
      this.state.selected = { productRef: updated.productRef, variantRef: updated.variantRef, source: "options" };
      this.syncCards([updated], card.entry.id);
      this.save();
    }
    this.renderAll();
  }

  private optionsPanelHtml(key: string, panel: CardOptionsState) {
    const card = escapeHtml(key);
    if (panel.loading) return `<div class="tryora-assistant__options" role="status"><span class="tryora-assistant__spinner" aria-hidden="true"></span> Loading options…</div>`;
    if (panel.error || !panel.data) return `<div class="tryora-assistant__options"><p class="tryora-assistant__composer-error" role="alert">${escapeHtml(panel.error || "Options are unavailable.")}</p>
      <button type="button" class="tryora-assistant__chip-button" data-ta="options" data-card="${card}">Close</button></div>`;
    const data = panel.data;
    const groups = data.attributes.map((attribute) => {
      const values = valuesFor(data, attribute, panel.selections);
      const swatches = attribute.kind === "colour" || values.some((value) => value.colour || value.image);
      const buttons = values.map((value) => {
        const label = `${value.value}${value.soldOut ? " (sold out)" : ""}`;
        const common = `type="button" data-ta="opt" data-card="${card}" data-attr="${escapeHtml(attribute.name)}" data-value="${escapeHtml(value.value)}" aria-pressed="${value.selected}" ${value.disabled ? "disabled" : ""}`;
        if (!swatches) return `<button ${common} class="tryora-assistant__opt${value.soldOut ? " is-soldout" : ""}">${escapeHtml(label)}</button>`;
        const colour = value.colour && /^#[0-9a-f]{3,8}$/i.test(value.colour) ? value.colour : null;
        const dot = value.image ? `<img src="${escapeHtml(value.image)}" alt="" loading="lazy">` : `<i${colour ? ` style="background:${colour}"` : ""}></i>`;
        return `<button ${common} class="tryora-assistant__swatch${value.soldOut ? " is-soldout" : ""}" aria-label="${escapeHtml(label)}">
          <span class="tryora-assistant__swatch-dot${colour || value.image ? "" : " is-plain"}">${dot}</span><span class="tryora-assistant__swatch-name">${escapeHtml(value.value)}</span></button>`;
      }).join("");
      return `<fieldset class="tryora-assistant__optgroup"><legend>${escapeHtml(attribute.name)}${panel.selections[attribute.name] ? `: <strong>${escapeHtml(panel.selections[attribute.name]!)}</strong>` : ""}</legend>
        <div class="tryora-assistant__optrow${swatches ? " is-swatches" : ""}">${buttons}</div></fieldset>`;
    }).join("");
    const missing = data.attributes.filter((attribute) => panel.selections[attribute.name] === undefined).map((attribute) => attribute.name.toLowerCase());
    const status = missing.length ? `Choose ${missing.join(", ")}.` : resolveVariant(data, panel.selections) ? "" : "That combination isn't available. Choose another option.";
    return `<div class="tryora-assistant__options">${groups}${status ? `<p class="tryora-assistant__image-note" role="status">${escapeHtml(status)}</p>` : ""}</div>`;
  }

  // ---------- helpers ----------

  private nearBottom() {
    const scroll = this.scroller();
    return !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  }

  private scrollToEnd(smooth: boolean) {
    const scroll = this.scroller();
    if (!scroll) return;
    if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top: scroll.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
    else scroll.scrollTop = scroll.scrollHeight;
  }

  private announce(text: string) {
    const live = this.root?.querySelector<HTMLElement>("[data-ta-live]");
    if (!live || !text || text === this.lastAnnounced) return;
    this.lastAnnounced = text;
    live.textContent = text.slice(0, 600);
  }

  private syncLauncher() {
    const launcher = this.context.launcher;
    if (!launcher) return;
    launcher.setAttribute("aria-expanded", String(this.visible));
    launcher.classList.toggle("is-hidden", this.visible);
    if (this.visible) launcher.classList.remove("has-unread");
    launcher.classList.toggle("has-conversation", !this.visible && this.state.entries.length > 0);
  }

  private syncLock() {
    // The side panel leaves the page usable; only fullscreen (and phones, via CSS) blocks page scrolling.
    document.documentElement.classList.toggle("tryora-assistant-locked", this.visible && this.state.ui.view === "fullscreen");
  }

  private save() { saveState(this.state); }
}
