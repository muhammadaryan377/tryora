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
import { historyFor, loadState, saveState, type ChatState, type Entry, type Recommendation } from "./session.js";

export interface AssistantConfig {
  enabled: boolean;
  configured: boolean;
  providerReady: boolean;
  greeting: string;
  shop?: string;
  defaultView?: "side" | "fullscreen";
  transport?: "poll" | "sse";
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
    this.state.preferences = null;
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
    this.state.preferences = null;
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
      this.state.selected = { productRef: numeric(this.context.productId), variantRef: variant && /^\d+$/.test(variant) ? variant : null };
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
        this.state.shown = reply.recommendations.map(({ productRef, variantRef }) => ({ productRef, variantRef }));
        this.renderEntry(reply.id);
        this.save();
        return;
      case "visualise":
        reply.visualise = event.item as Recommendation;
        this.state.selected = { productRef: reply.visualise.productRef, variantRef: reply.visualise.variantRef };
        this.renderEntry(reply.id);
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
    if (!item.previewAvailable) return;
    if (this.attachment && !this.roomPhoto) { this.roomPhoto = this.attachment; this.attachment = null; this.renderComposer(); }
    if (!this.roomPhoto) {
      this.pendingPreview = item;
      this.composerError = "";
      this.addNotice(`Add a room photo to see the ${item.title} in your room.`);
      this.openPicker("upload");
      return;
    }
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
      });
      if (controller.signal.aborted || !this.state.entries.includes(entry)) { URL.revokeObjectURL(url); return; }
      this.previewUrls.set(entry.id, url);
      entry.status = "ready";
      entry.stage = undefined;
      this.renderEntry(entry.id);
      // The image is now on screen: acknowledge delivery, exactly as the product popup does.
      acknowledge();
      this.announce(`Your AI room preview of the ${item.title} is ready.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof PreviewError ? error.code : (error as any)?.code ?? "FAILED";
      entry.status = "failed";
      entry.stage = undefined;
      if (code === "LEAD_REQUIRED") {
        entry.error = "This store asks for your email before creating previews. You can continue on the product page.";
        entry.handoff = item.url.includes("#") ? item.url : `${item.url}#tryora`;
      } else entry.error = previewErrorMessage(code);
      this.renderEntry(entry.id);
    } finally {
      this.previews.delete(entry.id);
      this.save();
    }
  }

  private abortAll() {
    this.active?.controller.abort();
    this.active = null;
    for (const controller of this.previews.values()) controller.abort();
    this.previews.clear();
  }

  private addNotice(text: string) {
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
    root.addEventListener("input", (event) => { if ((event.target as HTMLElement).matches("textarea")) this.autosize(); });
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
    const streaming = entry.status === "streaming";
    const status = streaming ? `<p class="tryora-assistant__status" data-ta-status ${entry.text ? "hidden" : ""}><span class="tryora-assistant__dots" aria-hidden="true"><i></i><i></i><i></i></span>${escapeHtml(this.stageLabel(entry.stage))}</p>` : "";
    const error = entry.status === "error" || entry.status === "stopped"
      ? `<div class="tryora-assistant__failed" role="${entry.status === "error" ? "alert" : "status"}"><span>${escapeHtml(entry.status === "stopped" ? "Stopped." : entry.error ?? errorMessage(""))}</span>
          <button type="button" class="tryora-assistant__chip-button" data-ta="retry" data-id="${id}">Retry</button></div>` : "";
    const text = entry.text || streaming ? `<div class="tryora-assistant__bubble ${entry.text ? "" : "is-empty"}" aria-busy="${streaming}">${status}<div class="tryora-assistant__text" data-ta-text>${formatText(entry.text)}</div></div>` : "";
    return `<div class="tryora-assistant__message tryora-assistant__message--assistant" data-entry="${id}">
      ${text}${error}
      ${entry.recommendations.length ? `<div class="tryora-assistant__cards">${entry.recommendations.map((item, index) => this.cardHtml(item, index)).join("")}</div>` : ""}
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

  private cardHtml(item: Recommendation, index: number) {
    const options = Object.entries(item.options).map(([name, value]) => `<span class="tryora-assistant__tag">${escapeHtml(name)}: ${escapeHtml(value)}</span>`).join("");
    const id = escapeHtml(item.id);
    return `<article class="tryora-assistant__card">
      ${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy">` : `<span class="tryora-assistant__card-placeholder">${ICONS.sofa}</span>`}
      <div class="tryora-assistant__card-body">
        <span class="tryora-assistant__eyebrow">Option ${index + 1}</span>
        <h4>${escapeHtml(item.title)}</h4>
        ${options ? `<div class="tryora-assistant__tags">${options}</div>` : ""}
        ${this.priceHtml(item)}
        <div class="tryora-assistant__tags">${this.badgesHtml(item)}</div>
        ${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ""}
        <div class="tryora-assistant__card-actions">
          <a class="tryora-assistant__secondary" href="${escapeHtml(item.url)}">View product</a>
          ${item.previewAvailable ? `<button type="button" class="tryora-assistant__primary" data-ta="preview" data-id="${id}">See it in my room</button>` : ""}
        </div>
      </div>
    </article>`;
  }

  private visualiseHtml(item: Recommendation) {
    const options = Object.values(item.options).join(" / ");
    return `<div class="tryora-assistant__visualise">
      ${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy">` : ""}
      <div>
        <span class="tryora-assistant__eyebrow">AI room preview</span>
        <h4>${escapeHtml(item.title)}</h4>
        ${options ? `<p>${escapeHtml(options)}</p>` : ""}
        <p class="tryora-assistant__fineprint">${this.roomPhoto ? "Uses your room photo." : "You'll be asked for a room photo."} Tryora places the item automatically.</p>
        <button type="button" class="tryora-assistant__primary" data-ta="preview" data-id="${escapeHtml(item.id)}">Generate preview</button>
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
