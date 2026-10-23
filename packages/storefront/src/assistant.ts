export interface AssistantConfig {
  enabled: boolean;
  configured: boolean;
  providerReady: boolean;
  greeting: string;
  launcher: { label: string; position: "bottom-left" | "bottom-right"; colour: string };
}

interface AssistantRecommendation {
  id: string;
  productId: string;
  variantId: string;
  title: string;
  url: string;
  image: string | null;
  price: string;
  currencyCode: string;
  options: Record<string, string>;
  previewAvailable: boolean;
  reason: string;
}

interface AssistantReply {
  message: string;
  room: { colours: string[]; style: string; lighting: string; notes: string } | null;
  recommendations: AssistantRecommendation[];
}

interface Message { role: "user" | "assistant"; content: string }

const PROXY = "/apps/tryora";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

function storedVisitorId() {
  try {
    const existing = localStorage.getItem("tryora_vid");
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem("tryora_vid", id);
    return id;
  } catch { return crypto.randomUUID(); }
}

async function prepareRoomPhoto(file: File): Promise<{ blob: Blob; url: string }> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new Error("Please choose a JPG, PNG, WEBP or HEIC room photo.");
  }
  if (file.size > 25 * 1024 * 1024) throw new Error("Please choose a photo under 25 MB.");
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width < 400 || bitmap.height < 300) throw new Error("Please choose a larger room photo.");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) throw new Error("We couldn't read that photo.");
    return { blob, url: URL.createObjectURL(blob) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Please")) throw error;
    throw new Error("We couldn't read that photo. Please try another one.");
  }
}

async function sendMessage(history: Message[], productId?: string, photo?: Blob): Promise<AssistantReply> {
  const form = new FormData();
  form.set("visitor", storedVisitorId());
  form.set("history", JSON.stringify(history.slice(-12)));
  if (productId) form.set("product", productId);
  if (photo) form.set("photo", photo, "room.jpg");
  const response = await fetch(`${PROXY}/assistant/message`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
    signal: AbortSignal.timeout(55_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error === "RATE_LIMITED"
      ? "The room assistant is busy. Please wait a moment and try again."
      : body.error === "BAD_PHOTO"
        ? "That room photo couldn't be read. Please choose another one."
        : "The room assistant is temporarily unavailable. Please try again.";
    throw new Error(message);
  }
  return body as AssistantReply;
}

export class RoomAssistant {
  private root: HTMLElement | null = null;
  private lastFocus: Element | null = null;
  private screen: "home" | "recommend" | "chat" = "home";
  private history: Message[] = [];
  private reply: AssistantReply | null = null;
  private photo: { blob: Blob; url: string } | null = null;
  private loading = false;
  private error = "";
  private draft = "";

  constructor(
    private readonly config: AssistantConfig,
    private readonly context: { productId?: string; openCurrentPreview?: () => void },
  ) {}

  open() {
    if (this.root) return;
    this.lastFocus = document.activeElement;
    const root = document.createElement("div");
    root.className = "tryora-assistant";
    root.style.setProperty("--ta-accent", this.config.launcher.colour);
    root.addEventListener("click", (event) => this.onClick(event));
    root.addEventListener("change", (event) => void this.onChange(event));
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("keydown", (event) => this.onKey(event));
    document.body.appendChild(root);
    document.documentElement.classList.add("tryora-open");
    this.root = root;
    this.render();
    root.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }

  close() {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    document.documentElement.classList.remove("tryora-open");
    (this.lastFocus as HTMLElement | null)?.focus?.();
  }

  private onInput(event: Event) {
    const target = event.target as HTMLTextAreaElement;
    if (target.name === "assistant-message") this.draft = target.value.slice(0, 800);
  }

  private async onChange(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.dataset.assistantFile === undefined) return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this.error = "";
    try {
      const next = await prepareRoomPhoto(file);
      if (this.photo) URL.revokeObjectURL(this.photo.url);
      this.photo = next;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "We couldn't read that photo.";
    }
    this.render();
  }

  private onClick(event: Event) {
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-assistant-act]");
    if (!element) {
      if (event.target === this.root?.querySelector(".tryora-assistant__backdrop")) this.close();
      return;
    }
    const action = element.dataset.assistantAct;
    if (action === "close") return this.close();
    if (action === "home") { this.screen = "home"; this.error = ""; return this.render(); }
    if (action === "recommend") { this.screen = "recommend"; this.error = ""; return this.render(); }
    if (action === "chat") { this.screen = "chat"; this.error = ""; return this.render(); }
    if (action === "choose-photo") return this.root?.querySelector<HTMLInputElement>("[data-assistant-file]")?.click();
    if (action === "analyse") return void this.recommend();
    if (action === "send") return void this.chat();
    if (action === "preview-current") {
      if (!this.context.openCurrentPreview) {
        this.error = "This product is not configured for a room preview.";
        return this.render();
      }
      this.close();
      return this.context.openCurrentPreview();
    }
  }

  private onKey(event: KeyboardEvent) {
    if (event.key === "Escape") return this.close();
    if (event.key !== "Tab" || !this.root) return;
    const focusable = [...this.root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, textarea")];
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  private async recommend() {
    if (!this.photo || this.loading) return;
    this.loading = true;
    this.error = "";
    const prompt = "Analyse my room and recommend up to three real beds or furniture products from this store that suit it.";
    const history = [...this.history, { role: "user" as const, content: prompt }].slice(-12);
    this.render();
    try {
      const reply = await sendMessage(history, this.context.productId, this.photo.blob);
      this.history = [...history, { role: "assistant" as const, content: reply.message }].slice(-12);
      this.reply = reply;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The room assistant is temporarily unavailable.";
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async chat() {
    const message = this.draft.trim();
    if (!message || this.loading) return;
    this.loading = true;
    this.error = "";
    this.draft = "";
    const history = [...this.history, { role: "user" as const, content: message }].slice(-12);
    this.history = history;
    this.render();
    try {
      const reply = await sendMessage(history, this.context.productId);
      this.history = [...history, { role: "assistant" as const, content: reply.message }].slice(-12);
      this.reply = reply;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The room assistant is temporarily unavailable.";
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private recommendations() {
    const recommendations = this.reply?.recommendations ?? [];
    if (!recommendations.length) return "";
    return `<div class="tryora-assistant__recommendations">${recommendations.map((item, index) => {
      const price = Number.isFinite(Number(item.price))
        ? new Intl.NumberFormat(undefined, { style: "currency", currency: item.currencyCode }).format(Number(item.price))
        : "";
      const options = Object.entries(item.options).map(([name, value]) =>
        `<span class="tryora-assistant__tag">${escapeHtml(name)}: ${escapeHtml(value)}</span>`).join("");
      const href = `${item.url}${item.url.includes("#") ? "" : "#tryora"}`;
      return `<article class="tryora-assistant__product">
        ${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy">` : ""}
        <div class="tryora-assistant__product-copy">
          <span class="tryora-assistant__eyebrow">Recommendation ${index + 1}</span>
          <h3>${escapeHtml(item.title)}</h3>
          <div class="tryora-assistant__tags">${options}</div>
          ${price ? `<strong>${escapeHtml(price)}</strong>` : ""}
          <p>${escapeHtml(item.reason)}</p>
          <a class="tryora-assistant__product-link" href="${escapeHtml(href)}">View options and preview</a>
        </div>
      </article>`;
    }).join("")}</div>`;
  }

  private transcript() {
    return this.history.map((message) => `<div class="tryora-assistant__message tryora-assistant__message--${message.role}">
      <span class="tryora-assistant__eyebrow">${message.role === "user" ? "You" : "Room assistant"}</span>
      <p>${escapeHtml(message.content)}</p>
    </div>`).join("");
  }

  private home() {
    const previewDisabled = !this.context.openCurrentPreview;
    return `<div class="tryora-assistant__welcome">
      <span class="tryora-assistant__spark" aria-hidden="true">✦</span>
      <div><h2>${escapeHtml(this.config.greeting)}</h2><p>I can help you visualise and choose the right furniture for your room.</p></div>
    </div>
    <div class="tryora-assistant__choices">
      <button data-assistant-act="preview-current" ${previewDisabled ? "disabled" : ""}>
        <span class="tryora-assistant__choice-icon" aria-hidden="true">▧</span>
        <span><strong>Preview this product in my room</strong><small>${previewDisabled ? "Preview is not configured for this product" : "See the product you are viewing in your own space"}</small></span><b aria-hidden="true">›</b>
      </button>
      <button data-assistant-act="recommend">
        <span class="tryora-assistant__choice-icon" aria-hidden="true">✦</span>
        <span><strong>Recommend furniture for my room</strong><small>Upload a room photo and get verified model and colour ideas</small></span><b aria-hidden="true">›</b>
      </button>
    </div>
    <button class="tryora-assistant__ask" data-assistant-act="chat"><span aria-hidden="true">◯</span> Ask a question <b aria-hidden="true">›</b></button>`;
  }

  private recommendScreen() {
    return `<button class="tryora-assistant__back" data-assistant-act="home">‹ Back</button>
      <h2>Recommend furniture for my room</h2>
      <p class="tryora-assistant__muted">Upload a clear photo showing the room, floor and existing furniture. The image is used for this request and is not saved by Tryora.</p>
      <input data-assistant-file hidden type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif">
      ${this.photo ? `<img class="tryora-assistant__room" src="${escapeHtml(this.photo.url)}" alt="Your selected room photo">
        <button class="tryora-assistant__secondary" data-assistant-act="choose-photo" ${this.loading ? "disabled" : ""}>Choose another photo</button>
        <button class="tryora-assistant__primary" data-assistant-act="analyse" ${this.loading ? "disabled" : ""}>${this.loading ? "Analysing your room…" : "Analyse and recommend"}</button>`
        : `<button class="tryora-assistant__upload" data-assistant-act="choose-photo"><span aria-hidden="true">＋</span><strong>Choose a room photo</strong><small>JPG, PNG, WEBP or HEIC, up to 25 MB</small></button>`}
      ${this.loading ? `<div class="tryora-assistant__loading" role="status"><span></span> Checking your room against verified products…</div>` : ""}
      ${this.reply ? `<div class="tryora-assistant__answer" aria-live="polite"><p>${escapeHtml(this.reply.message)}</p></div>${this.recommendations()}` : ""}`;
  }

  private chatScreen() {
    return `<button class="tryora-assistant__back" data-assistant-act="home">‹ Back</button>
      <h2>Ask the room assistant</h2>
      <div class="tryora-assistant__transcript" aria-live="polite">${this.transcript() || `<p class="tryora-assistant__muted">Ask about real products, colours, sizes, availability or what may suit your room.</p>`}</div>
      ${this.recommendations()}
      ${this.loading ? `<div class="tryora-assistant__loading" role="status"><span></span> Checking the store catalogue…</div>` : ""}
      <label class="tryora-assistant__composer"><span class="tryora-assistant__sr">Your question</span>
        <textarea name="assistant-message" maxlength="800" rows="2" placeholder="Which bed would suit a smaller room?" ${this.loading ? "disabled" : ""}>${escapeHtml(this.draft)}</textarea>
        <button data-assistant-act="send" aria-label="Send question" ${this.loading ? "disabled" : ""}>↑</button>
      </label>`;
  }

  private render() {
    if (!this.root) return;
    const body = this.screen === "home" ? this.home() : this.screen === "recommend" ? this.recommendScreen() : this.chatScreen();
    this.root.innerHTML = `<div class="tryora-assistant__backdrop"></div>
      <section class="tryora-assistant__dialog" role="dialog" aria-modal="true" aria-labelledby="tryora-assistant-title">
        <header><h1 id="tryora-assistant-title">Room assistant</h1><button data-assistant-act="close" aria-label="Close room assistant">×</button></header>
        <main>${this.error ? `<p class="tryora-assistant__error" role="alert">${escapeHtml(this.error)}</p>` : ""}${body}</main>
      </section>`;
  }
}

export function buildAssistantLauncher(config: AssistantConfig, open: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tryora-assistant-launch tryora-assistant-launch--${config.launcher.position}`;
  button.style.setProperty("--ta-accent", config.launcher.colour);
  button.setAttribute("aria-label", config.launcher.label);
  button.innerHTML = `<span aria-hidden="true">✦</span><span>${escapeHtml(config.launcher.label)}</span>`;
  button.addEventListener("click", open);
  return button;
}

export async function fetchAssistantConfig(root: HTMLElement): Promise<AssistantConfig | null> {
  const query = new URLSearchParams({ pageType: root.dataset.pageType ?? "" });
  if (root.dataset.productId) query.set("product", root.dataset.productId);
  if (root.dataset.productHandle) query.set("productHandle", root.dataset.productHandle);
  if (root.dataset.collectionId) query.set("collection", root.dataset.collectionId);
  if (root.dataset.collectionHandle) query.set("collectionHandle", root.dataset.collectionHandle);
  try {
    const response = await fetch(`${PROXY}/assistant/config?${query}`, { credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.json() as AssistantConfig;
  } catch { return null; }
}
