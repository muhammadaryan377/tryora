// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAssistantLauncher, RoomAssistant } from "../../packages/storefront/src/assistant";
import { IDLE_MS, sessionKey, wasOpen } from "../../packages/storefront/src/assistant/session";

const SHOP = "demo.myshopify.com";
const config = {
  enabled: true, configured: true, providerReady: true, greeting: "How can I help?", shop: SHOP, defaultView: "side" as const, transport: "poll" as const,
  launcher: { label: "Room Assistant", position: "bottom-right" as const, colour: "#6f7046" },
};

const card = (overrides: Record<string, unknown> = {}) => ({
  id: "1:11", productRef: "1", variantRef: "11", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/11",
  title: "Aria Bed", url: "/products/aria?variant=11", image: "https://cdn.shopify.com/aria.jpg", price: "999.00", maxPrice: null, currencyCode: "GBP",
  options: { Colour: "Cream" }, purchaseAvailable: true, previewAvailable: true, previewStatus: "available", optionValue: "Cream", reason: "Suits the room.", ...overrides,
});

/** A scripted app proxy: each turn returns its event batches one long-poll at a time. */
function fakeProxy() {
  const turns: any[][][] = [];
  const forms: FormData[] = [];
  const calls: { method: string; url: string; body?: FormData }[] = [];
  let pollGate: Promise<void> | null = null;
  const respond = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  const fetcher = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    calls.push({ method: init.method ?? "GET", url, body: init.body as FormData });
    if (url.startsWith("/apps/tryora/assistant/suggestions?")) return respond({ suggestions: proxy.suggestions, recommendation: proxy.recommendation });
    if (url === "/apps/tryora/assistant/turn") { forms.push(init.body as FormData); return respond({ turnId: `turn${forms.length}` }); }
    const poll = url.match(/assistant\/turn\/turn(\d+)\?visitor=[^&]+&after=(\d+)/);
    if (poll) {
      if (pollGate) await pollGate;
      const batches = turns[Number(poll[1]) - 1] ?? [[{ type: "done" }]];
      const sent = batches.slice(0, batches.length).reduce((count, batch, index) => count, 0);
      const after = Number(poll[2]);
      let seen = 0;
      for (const batch of batches) {
        if (seen >= after) return respond({ events: batch, next: seen + batch.length, done: batch.some((event: any) => ["done", "error", "cancelled"].includes(event.type)) });
        seen += batch.length;
      }
      void sent;
      return respond({ events: [], next: after, done: false });
    }
    if (/assistant\/turn\/turn\d+\/cancel/.test(url)) return respond({ cancelled: true });
    if (url === "/apps/tryora/preview") return respond(proxy.previewError ? { error: proxy.previewError } : { jobId: "job1" }, proxy.previewError ? 400 : 200);
    if (url.startsWith("/apps/tryora/preview/job1")) return respond({ stage: "ready", image: "data:image/jpeg;base64,YQ==", token: "tok", expiresAt: Date.now() + 60_000 });
    if (url === "/apps/tryora/ack") return respond({ ok: true });
    if (url.startsWith("/apps/tryora/assistant/options?")) return proxy.options ? respond(proxy.options) : respond({ error: "NOT_FOUND" }, 404);
    if (url.startsWith("/apps/tryora/assistant/preview-check?")) {
      // By default the server confirms what the options model offered; a test can return a precise refusal instead.
      const variantId = new URL(url, "https://shop.example").searchParams.get("variant");
      const variant = proxy.options?.variants.find((v: any) => v.id === variantId);
      // A test can hold the check open to reproduce a shopper changing options while it is pending.
      if (proxy.checkGate) await proxy.checkGate;
      const answer = typeof proxy.check === "function" ? proxy.check(variantId) : proxy.check;
      return respond(answer ?? { variantId, previewAvailable: true, previewStatus: "available", previewReason: null, optionValue: variant?.previewOption ?? null, referenceImage: null });
    }
    if (url === "/apps/tryora/lead") {
      const email = String((init.body as FormData).get("email") ?? "");
      return email.includes("@") ? respond({ ok: true }) : respond({ error: "BAD_EMAIL" }, 400);
    }
    if (url.startsWith("data:")) return new Response(new Blob(["a"], { type: "image/jpeg" }));
    throw new Error(`Unexpected request ${url}`);
  });
  const proxy = {
    suggestions: [] as string[],
    recommendation: null as any,
    fetcher, forms, calls, turns, previewError: "" as string, options: null as any, check: null as any, checkGate: null as Promise<void> | null,
    script(...batches: any[][]) { turns.push(batches); },
    hold() { let release!: () => void; pollGate = new Promise((resolve) => { release = resolve; }); return () => { pollGate = null; release(); }; },
  };
  return proxy;
}

/** XHR stand-in so uploads with a photo report progress like a browser. */
function fakeXhr(proxy: ReturnType<typeof fakeProxy>) {
  return class {
    upload: any = {};
    status = 0;
    responseText = "";
    withCredentials = false;
    timeout = 0;
    onload: any; onerror: any; ontimeout: any;
    private url = "";
    open(_method: string, url: string) { this.url = url; }
    send(body: FormData) {
      setTimeout(async () => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
        const response = await proxy.fetcher(this.url, { method: "POST", body });
        this.status = response.status;
        this.responseText = await response.text();
        this.onload?.();
      }, 5);
    }
    abort() {}
  };
}

const photo = (name = "room.jpg") => ({ blob: new Blob(["room"], { type: "image/jpeg" }), url: `blob:${name}`, name });

let proxy: ReturnType<typeof fakeProxy>;
let launcher: HTMLElement;
let openPreview: ReturnType<typeof vi.fn<() => void>>;

function makeAssistant(extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  launcher = buildAssistantLauncher(config, () => {});
  document.body.appendChild(launcher);
  return new RoomAssistant({ ...config, ...overrides } as any, {
    productId: "1", productNoun: "bed", openCurrentPreview: openPreview, launcher, currentVariantId: () => "11",
    preparePhoto: async (file: File) => photo(file.name), ...extra,
  }) as any;
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const click = (selector: string) => { const element = $(selector); if (!element) throw new Error(`Missing ${selector}`); element.click(); };
const settle = async (ms = 30) => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, ms / 6)); };
async function attachFile(name = "room.jpg", type = "image/jpeg") {
  const input = $('[data-ta-file="upload"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["x"], name, { type })], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}
async function type(text: string) {
  const textarea = $("textarea") as HTMLTextAreaElement;
  textarea.value = text;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  localStorage.setItem("tryora_vid", "00000000-0000-4000-8000-000000000001");
  proxy = fakeProxy();
  openPreview = vi.fn<() => void>();
  vi.stubGlobal("fetch", proxy.fetcher);
  vi.stubGlobal("XMLHttpRequest", fakeXhr(proxy));
  vi.stubGlobal("Image", class { src = ""; decode() { return Promise.resolve(); } });
  URL.createObjectURL = vi.fn(() => "blob:preview") as any;
  URL.revokeObjectURL = vi.fn() as any;
});
afterEach(() => vi.unstubAllGlobals());

describe("launcher", () => {
  it("is a labelled, keyboard-accessible pill that respects the merchant's side", () => {
    const button = buildAssistantLauncher({ ...config, launcher: { ...config.launcher, position: "bottom-left", colour: "#123456" } }, () => {});
    expect(button.tagName).toBe("BUTTON");
    expect(button.className).toContain("tryora-assistant-launch--bottom-left");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.querySelector(".tryora-assistant-launch__label")!.textContent).toBe("Room Assistant");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.style.getPropertyValue("--ta-accent")).toBe("#123456");
  });

  it("moves above a chat widget in the same corner", () => {
    const widget = document.createElement("div");
    widget.id = "shopify-chat";
    document.body.appendChild(widget);
    expect(buildAssistantLauncher(config, () => {}).classList.contains("tryora-assistant-launch--above-chat")).toBe(true);
  });
});

describe("drawer modes", () => {
  it("opens as a right-side panel, toggles fullscreen and restores without losing the conversation", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "final", reply: { message: "Hello!", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    const root = $(".tryora-assistant")!;
    expect(root.hidden).toBe(false);
    expect(root.dataset.view).toBe("side");
    expect($(".tryora-assistant__panel")!.getAttribute("aria-modal")).toBe("false");
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe($("textarea"));
    await type("Hi");
    click("[data-ta='send']");
    await settle(60);
    click("[data-ta='view']");
    expect(root.dataset.view).toBe("fullscreen");
    expect($(".tryora-assistant__panel")!.getAttribute("aria-modal")).toBe("true");
    expect($("[data-ta='view']")!.getAttribute("aria-label")).toBe("Restore side panel");
    expect(document.documentElement.classList.contains("tryora-assistant-locked")).toBe(true);
    click("[data-ta='view']");
    expect(root.dataset.view).toBe("side");
    expect(document.documentElement.classList.contains("tryora-assistant-locked")).toBe(false);
    expect($$(".tryora-assistant__message").map((node) => node.textContent!.trim())).toEqual(["Hi", "Hello!"]);
  });

  it("minimises and restores with the conversation intact, and close keeps history", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "final", reply: { message: "Hello!", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Hi");
    click("[data-ta='send']");
    await settle(60);
    click("[data-ta='minimise']");
    expect($(".tryora-assistant")!.hidden).toBe(true);
    expect(launcher.classList.contains("has-conversation")).toBe(true);
    expect(document.activeElement).toBe(launcher);
    assistant.open();
    expect($$(".tryora-assistant__message")).toHaveLength(2);
    click("[data-ta='close']");
    expect($(".tryora-assistant")!.hidden).toBe(true);
    assistant.open();
    expect($$(".tryora-assistant__message")).toHaveLength(2);
  });

  it("minimises on Escape, sends on Enter and keeps Shift+Enter for new lines", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "final", reply: { message: "Sure", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    const textarea = $("textarea") as HTMLTextAreaElement;
    textarea.value = "line one";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(proxy.forms).toHaveLength(0);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(60);
    expect(proxy.forms).toHaveLength(1);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(assistant.isOpen).toBe(false);
  });
});

describe("welcome screen", () => {
  it("offers only two main photo actions", async () => {
    const assistant = makeAssistant();
    assistant.open();
    expect($$("[data-ta='welcome']").map((button) => button.dataset.action)).toEqual(["visualise", "recommend"]);
    expect($("textarea")!.getAttribute("placeholder")).toBe("Describe your room or ask for a preview\u2026");
    const picker = $('[data-ta-file="upload"]') as HTMLInputElement;
    const pick = vi.spyOn(picker, "click");
    ($("textarea") as HTMLTextAreaElement).blur();
    assistant.welcomeAction("ask");
    expect(document.activeElement).toBe($("textarea"));
    click("[data-action='recommend']");
    expect(pick).not.toHaveBeenCalled();
    expect($(".tryora-assistant__photo-screen h3")!.textContent).toBe("Add a photo of your room");
    click("[data-ta='upload']");
    expect(pick).toHaveBeenCalledTimes(1);
    await attachFile();
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("Which furniture from this store would suit this room?");
    expect($("[data-ta-attachment] img")!.getAttribute("src")).toBe("blob:room.jpg");
  });

  it("starts the visualise flow on a product page and can hand off to the product's own preview", async () => {
    const assistant = makeAssistant();
    assistant.open();
    const pick = vi.spyOn($('[data-ta-file="upload"]') as HTMLInputElement, "click");
    click("[data-action='visualise']");
    expect(pick).not.toHaveBeenCalled();
    expect($(".tryora-assistant__photo-screen h3")!.textContent).toBe("Add a photo to preview this bed");
    click("[data-ta='upload']");
    expect(pick).toHaveBeenCalled();
    await attachFile();
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("Show this product in my room.");
    proxy.script([{ type: "final", reply: { message: "Here is the card.", recommendations: [] } }, { type: "done" }]);
    click("[data-ta='send']");
    await settle(60);
    expect(JSON.parse(String(proxy.forms[0]!.get("selected")))).toEqual({ productRef: "1", variantRef: "11", source: "options" });
    assistant.newChat();
    click("[data-ta='product-preview']");
    expect(openPreview).toHaveBeenCalled();
    expect(assistant.isOpen).toBe(false);
  });
});

describe("chat image upload", () => {
  it("previews, replaces and removes an attachment, and rejects unsupported files", async () => {
    const assistant = makeAssistant({ preparePhoto: async (file: File) => {
      if (!file.type.startsWith("image/")) throw Object.assign(new (await import("../../packages/storefront/src/assistant/photo")).PhotoError("Please choose a JPG, PNG, WEBP or HEIC room photo."));
      return photo(file.name);
    } });
    assistant.open();
    click("[data-ta='attach']");
    expect($(".tryora-assistant__menu--attach")!.hidden).toBe(false);
    expect($("[data-ta='upload']")).not.toBeNull();
    await attachFile("first.jpg");
    expect($("[data-ta-attachment] img")!.getAttribute("src")).toBe("blob:first.jpg");
    await attachFile("second.jpg");
    expect($("[data-ta-attachment] img")!.getAttribute("src")).toBe("blob:second.jpg");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:first.jpg");
    click("[data-ta='remove-photo']");
    expect($("[data-ta-attachment]")!.hidden).toBe(true);
    await attachFile("notes.pdf", "application/pdf");
    expect($("[data-ta-error]")!.textContent).toMatch(/JPG, PNG, WEBP or HEIC/);
  });

  it("uploads the photo with progress, streams the answer and keeps room analysis for follow-ups", async () => {
    const assistant = makeAssistant();
    proxy.script(
      [{ type: "status", stage: "analysing_room" }],
      [{ type: "room", room: { colours: ["white", "oak"], style: "Scandinavian", lighting: "bright", notes: "" } }, { type: "status", stage: "searching_products" }],
      [{ type: "recommendations", items: [card(), card({ id: "2:21", productRef: "2", variantRef: "21", title: "Oslo Couch", previewAvailable: false, previewStatus: "not_configured", optionValue: null })] }],
      [{ type: "delta", text: "Option 1 suits " }],
      [{ type: "delta", text: "your bright room." }],
      [{ type: "final", reply: { message: "Option 1 suits your bright room.", recommendations: [] } }, { type: "done" }],
    );
    proxy.script([{ type: "final", reply: { message: "Grey works too.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await attachFile();
    await type("Which bed would look best in this room?");
    const release = proxy.hold();
    click("[data-ta='send']");
    await settle(30);
    expect($(".tryora-assistant__send")!.dataset.ta).toBe("stop");
    expect($(".tryora-assistant__status")!.textContent).toMatch(/Uploading photo… 50%|Analysing/);
    release();
    await settle(120);
    const sent = proxy.forms[0]!;
    expect(sent.get("photo")).toBeInstanceOf(Blob);
    expect(sent.get("product")).toBe("gid://shopify/Product/1");
    expect(JSON.parse(String(sent.get("history")))).toEqual([{ role: "user", content: "Which bed would look best in this room?" }]);
    expect($(".tryora-assistant__user-photo")!.getAttribute("src")).toBe("blob:room.jpg");
    expect($$(".tryora-assistant__card h4").map((node) => node.textContent)).toEqual(["Aria Bed", "Oslo Couch"]);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe("Option 1 suits your bright room.");
    expect($(".tryora-assistant__room-chip")!.textContent).toMatch(/Scandinavian, white, oak/);
    // Follow-up: structured room notes and numbered cards are sent, the photo is not re-uploaded.
    await type("What about grey?");
    click("[data-ta='send']");
    await settle(60);
    const followUp = proxy.forms[1]!;
    expect(followUp.get("photo")).toBeNull();
    expect(followUp.get("hasPhoto")).toBe("1");
    expect(JSON.parse(String(followUp.get("room")))).toMatchObject({ style: "Scandinavian" });
    expect(JSON.parse(String(followUp.get("shown")))).toEqual([{ productRef: "1", variantRef: "11" }, { productRef: "2", variantRef: "21" }]);
    expect(JSON.parse(String(followUp.get("history")))).toEqual([
      { role: "user", content: "Which bed would look best in this room?" },
      { role: "assistant", content: "Option 1 suits your bright room." },
      { role: "user", content: "What about grey?" },
    ]);
  });

  it("renders streamed text progressively before the final answer", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "delta", text: "Looking at " }], [{ type: "delta", text: "beds now" }], [{ type: "final", reply: { message: "Looking at beds now.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    const seen: string[] = [];
    const original = proxy.fetcher.getMockImplementation()!;
    proxy.fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      seen.push($(".tryora-assistant__message--assistant .tryora-assistant__text")?.textContent ?? "");
      return original(url, init);
    });
    await type("beds?");
    click("[data-ta='send']");
    await settle(80);
    // Each line is trimmed for display, so the partial "Looking at " renders without its trailing space.
    expect(seen).toContain("Looking at");
    expect(seen).toContain("Looking at beds now");
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe("Looking at beds now.");
  });

  it("escapes model output instead of rendering markup", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "final", reply: { message: "**Great** <img src=x onerror=alert(1)>\n- one\n- two", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("hi");
    click("[data-ta='send']");
    await settle(60);
    const text = $(".tryora-assistant__message--assistant .tryora-assistant__text")!;
    expect(text.querySelector("img")).toBeNull();
    expect(text.querySelector("strong")!.textContent).toBe("Great");
    expect(text.querySelectorAll("li")).toHaveLength(2);
    expect(text.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("recommendation cards and previews", () => {
  it("shows purchase and preview availability separately", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "recommendations", items: [
      card(),
      card({ id: "3:", productRef: "3", variantRef: null, title: "Oslo Couch", url: "/products/oslo", previewAvailable: false, previewStatus: "not_configured", price: "799.00", maxPrice: "899.00", optionValue: null }),
      card({ id: "4:41", productRef: "4", title: "Luna Chair", purchaseAvailable: false, previewAvailable: false, previewStatus: "unavailable", optionValue: null }),
    ] }], [{ type: "final", reply: { message: "Three options.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("chairs?");
    click("[data-ta='send']");
    await settle(60);
    const cards = $$(".tryora-assistant__card");
    expect(cards).toHaveLength(3);
    expect(cards[0]!.querySelector("[data-ta='preview']")).not.toBeNull();
    // Every card has the same "Preview in my room" button; it is disabled, with the reason, when it cannot be used.
    expect(cards.map((node) => node.querySelector("[data-ta='preview']")!.textContent)).toEqual(Array(3).fill("Preview in my room"));
    expect(cards[1]!.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(cards[2]!.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(cards.every((node) => !node.querySelector(".tryora-assistant__badge"))).toBe(true);
    expect(cards[1]!.querySelector<HTMLButtonElement>(".tryora-assistant__primary")!.disabled).toBe(true);
    expect(cards[2]!.textContent).toContain("sold out");
    expect(cards[1]!.textContent).toMatch(/AI room preview is not configured/);
    expect(cards[1]!.textContent).toMatch(/799\.00.*–.*899\.00/);
    expect(cards[1]!.querySelector("a")!.getAttribute("href")).toBe("/products/oslo");
  });

  it("previews the newly edited room rather than silently reusing the old photo", async () => {
    const assistant = makeAssistant(); assistant.open();
    assistant.roomPhoto = photo("old.jpg");
    assistant.state.room = { colours: ["red"], style: "old room" };
    const edited = photo("new.jpg"); assistant.attachment = edited;
    await assistant.startPreview(card());
    expect(assistant.roomPhoto).toBe(edited);
    expect(assistant.attachment).toBeNull(); expect(assistant.state.room).toBeNull();
    const request = proxy.calls.find((c) => c.url === "/apps/tryora/preview")!;
    expect(request.body!.get("photo")).toBeInstanceOf(Blob);
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("generates a verified preview inside the chat through the existing preview endpoints and acknowledges after display", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "visualise", item: card() }], [{ type: "final", reply: { message: "Confirm to preview.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await attachFile();
    await type("Show it in my room");
    click("[data-ta='send']");
    await settle(60);
    click(".tryora-assistant__visualise [data-ta='preview']");
    await settle(1500);
    expect(assistant.state.selected).toEqual({ productRef: "1", variantRef: "11", source: "card" });
    const start = proxy.calls.find((call) => call.url === "/apps/tryora/preview")!;
    expect(start.body!.get("product")).toBe("gid://shopify/Product/1");
    expect(start.body!.get("variant")).toBe("gid://shopify/ProductVariant/11");
    expect(start.body!.get("option")).toBe("Cream");
    expect(start.body!.get("photo")).toBeInstanceOf(Blob);
    const image = $(".tryora-assistant__preview img")!;
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect($(".tryora-assistant__preview a[download]")).not.toBeNull();
    const ack = proxy.calls.findIndex((call) => call.url === "/apps/tryora/ack");
    expect(ack).toBeGreaterThan(-1);
    expect(proxy.calls[ack]!.body!.get("token")).toBe("tok");
  });

  async function cardWithPhoto(overrides: Record<string, unknown> = {}) {
    const assistant = makeAssistant({}, overrides);
    proxy.script([{ type: "recommendations", items: [card()] }], [{ type: "final", reply: { message: "Option 1.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("beds?");
    click("[data-ta='send']");
    await settle(60);
    return assistant;
  }
  const previewStarts = () => proxy.calls.filter((call) => call.url === "/apps/tryora/preview");
  async function fillEmail(value: string) {
    const input = $(".tryora-assistant__lead input[name='ta-lead-email']") as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("asks for a room photo once, however often preview is pressed", async () => {
    await cardWithPhoto({ lead: { mode: "off", timing: "before", showOptIn: false, optInWording: "" } });
    const pick = vi.spyOn($('[data-ta-file="upload"]') as HTMLInputElement, "click");
    click(".tryora-assistant__card [data-ta='preview']");
    click(".tryora-assistant__card [data-ta='preview']");
    expect(pick).toHaveBeenCalledTimes(2);
    expect($$(".tryora-assistant__notice")).toHaveLength(1);
    expect(previewStarts()).toHaveLength(0);
    await attachFile();
    await settle(1500);
    // The pending preview continues once the photo is added; "off" sends leadDone=1 with no email step.
    expect(previewStarts()).toHaveLength(1);
    expect(previewStarts()[0]!.body!.get("leadDone")).toBe("1");
  });

  it("collects the email inline before the preview when the store requires it, then continues", async () => {
    await cardWithPhoto({ lead: { mode: "required", timing: "before", showOptIn: true, optInWording: "Email me offers." } });
    await attachFile();
    click(".tryora-assistant__card [data-ta='preview']");
    click(".tryora-assistant__card [data-ta='preview']");
    expect($$(".tryora-assistant__lead")).toHaveLength(1);
    expect($(".tryora-assistant__lead [data-ta='lead-skip']")).toBeNull();
    expect(previewStarts()).toHaveLength(0);
    await fillEmail("not-an-email");
    click("[data-ta='lead-submit']");
    await settle(30);
    expect($(".tryora-assistant__lead [role='alert']")!.textContent).toBe("Please enter a valid email address.");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/lead")).toBe(false);
    await fillEmail("shopper@example.com");
    const consent = $(".tryora-assistant__lead input[name='ta-lead-marketing']") as HTMLInputElement;
    consent.checked = true;
    consent.dispatchEvent(new Event("change", { bubbles: true }));
    click("[data-ta='lead-submit']");
    await settle(1500);
    const lead = proxy.calls.filter((call) => call.url === "/apps/tryora/lead");
    expect(lead).toHaveLength(1);
    expect(Object.fromEntries([...lead[0]!.body!.entries()].filter(([, value]) => typeof value === "string"))).toEqual({
      email: "shopper@example.com", firstName: "", marketing: "1", wording: "Email me offers.", product: "gid://shopify/Product/1", option: "Cream",
    });
    expect(previewStarts()).toHaveLength(1);
    expect(previewStarts()[0]!.body!.get("leadDone")).toBe("1");
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    // The email is remembered for the session but never written to storage.
    expect(sessionStorage.getItem(sessionKey(SHOP))).not.toContain("shopper@example.com");
    click(".tryora-assistant__card [data-ta='preview']");
    await settle(1500);
    expect(previewStarts()).toHaveLength(2);
    expect($$(".tryora-assistant__lead")).toHaveLength(0);
  });

  it("shows the email form instead of a hand-off when the server reports LEAD_REQUIRED", async () => {
    await cardWithPhoto();
    await attachFile();
    proxy.previewError = "LEAD_REQUIRED";
    click(".tryora-assistant__card [data-ta='preview']");
    await settle(60);
    expect(previewStarts()[0]!.body!.get("leadDone")).toBe("0");
    expect($$(".tryora-assistant__lead")).toHaveLength(1);
    expect($(".tryora-assistant__message--preview")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Continue on product page/);
    proxy.previewError = "";
    await fillEmail("shopper@example.com");
    click("[data-ta='lead-submit']");
    await settle(1500);
    expect(previewStarts()).toHaveLength(2);
    expect(previewStarts()[1]!.body!.get("leadDone")).toBe("1");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/ack")).toBe(true);
  });

  it("follows 'after' timing: first preview immediately, then a single optional email prompt", async () => {
    await cardWithPhoto({ lead: { mode: "skippable", timing: "after", showOptIn: false, optInWording: "" } });
    await attachFile();
    click(".tryora-assistant__card [data-ta='preview']");
    await settle(1500);
    expect(previewStarts()[0]!.body!.get("leadDone")).toBe("1");
    expect($$(".tryora-assistant__lead")).toHaveLength(1);
    click("[data-ta='lead-skip']");
    click(".tryora-assistant__card [data-ta='preview']");
    await settle(1500);
    expect(previewStarts()).toHaveLength(2);
    expect($$(".tryora-assistant__lead")).toHaveLength(0);
  });

  it("never starts a second job while one is generating", async () => {
    await cardWithPhoto({ lead: { mode: "off", timing: "before", showOptIn: false, optInWording: "" } });
    await attachFile();
    click(".tryora-assistant__card [data-ta='preview']");
    (document.querySelector(".tryora-assistant__card [data-ta='preview']") as HTMLButtonElement | null)?.click();
    await settle(1500);
    expect(previewStarts()).toHaveLength(1);
  });
});

describe("conversation controls and errors", () => {
  it("stops a running answer, then retries the same question without duplicating it", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "status", stage: "searching_products" }], [{ type: "delta", text: "never shown" }]);
    proxy.script([{ type: "final", reply: { message: "Here you go.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("beds?");
    const release = proxy.hold();
    click("[data-ta='send']");
    await settle(20);
    click("[data-ta='stop']");
    release();
    await settle(60);
    expect(proxy.calls.some((call) => /turn1\/cancel$/.test(call.url))).toBe(true);
    expect($(".tryora-assistant__failed")!.textContent).toMatch(/Stopped/);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")?.textContent ?? "").not.toContain("never shown");
    click("[data-ta='retry']");
    await settle(60);
    expect($$(".tryora-assistant__message--user")).toHaveLength(1);
    expect($$(".tryora-assistant__message--assistant")).toHaveLength(1);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe("Here you go.");
  });

  it("shows understandable errors with Retry", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "error", code: "PROVIDER_TIMEOUT" }]);
    assistant.open();
    await type("beds?");
    click("[data-ta='send']");
    await settle(60);
    expect($(".tryora-assistant__failed")!.textContent).toMatch(/took too long/);
    expect($("[data-ta='retry']")).not.toBeNull();
  });

  it("New chat keeps the room, Forget room keeps messages, Clear conversation removes everything", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "room", room: { colours: ["green"], style: "modern", lighting: "soft", notes: "" } }, { type: "final", reply: { message: "Nice room.", recommendations: [] } }, { type: "done" }]);
    proxy.script([{ type: "final", reply: { message: "Again.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await attachFile();
    await type("Thoughts?");
    click("[data-ta='send']");
    await settle(60);
    click("[data-ta='more']");
    click("[data-ta='new-chat']");
    expect($$(".tryora-assistant__message")).toHaveLength(0);
    expect($(".tryora-assistant__room-chip")!.textContent).toMatch(/modern, green/);
    await type("Hello again");
    click("[data-ta='send']");
    await settle(60);
    click(".tryora-assistant__room-chip [data-ta='forget-room']");
    expect($(".tryora-assistant__room-chip")).toBeNull();
    expect($$(".tryora-assistant__message")).toHaveLength(2);
    click("[data-ta='more']");
    click("[data-ta='clear']");
    expect($$(".tryora-assistant__message")).toHaveLength(0);
    expect($(".tryora-assistant__welcome")).not.toBeNull();
    // Only the open/closed drawer state remains; no messages, room notes or recommendations.
    const kept = JSON.parse(sessionStorage.getItem(sessionKey(SHOP)) ?? "{}");
    expect(kept).toMatchObject({ entries: [], room: null, shown: [], selected: null, preferences: null });
  });
});

describe("conversation history", () => {
  it("survives navigation and refresh in the same tab, without photos or object URLs", async () => {
    const first = makeAssistant();
    proxy.script([{ type: "room", room: { colours: ["white"], style: "minimal", lighting: "bright", notes: "" } }, { type: "recommendations", items: [card()] }, { type: "final", reply: { message: "Option 1.", recommendations: [] } }, { type: "done" }]);
    first.open();
    await attachFile();
    await type("Beds for this room?");
    click("[data-ta='send']");
    await settle(60);
    const stored = sessionStorage.getItem(sessionKey(SHOP))!;
    expect(stored).not.toContain("blob:");
    expect(stored).not.toContain("base64");
    // A new page load in the same tab.
    document.body.innerHTML = "";
    const second = makeAssistant();
    second.open();
    expect($$(".tryora-assistant__message--user .tryora-assistant__bubble").map((node) => node.textContent)).toEqual(["Beds for this room?"]);
    expect($(".tryora-assistant__photo-note")!.textContent).toMatch(/not kept after the page reloads/);
    expect($(".tryora-assistant__card h4")!.textContent).toBe("Aria Bed");
    expect($(".tryora-assistant__room-chip")!.textContent).toMatch(/minimal/);
    proxy.script([{ type: "final", reply: { message: "Yes.", recommendations: [] } }, { type: "done" }]);
    await type("Does the first one come in grey?");
    click("[data-ta='send']");
    await settle(60);
    const form = proxy.forms.at(-1)!;
    expect(JSON.parse(String(form.get("shown")))).toEqual([{ productRef: "1", variantRef: "11" }]);
    expect(form.get("hasPhoto")).toBe("0");
  });

  it("expires idle history, ignores other stores and removes the legacy shared key", () => {
    sessionStorage.setItem("tryora_assistant_context", JSON.stringify({ room: { style: "old store" }, shown: [] }));
    sessionStorage.setItem(sessionKey("other.myshopify.com"), JSON.stringify({ v: 2, shop: "other.myshopify.com", createdAt: Date.now(), updatedAt: Date.now(), entries: [{ id: "x", kind: "user", text: "secret", photo: false, at: 1 }], ui: { open: true, view: "side" } }));
    const stale = { v: 2, shop: SHOP, createdAt: Date.now() - IDLE_MS - 10, updatedAt: Date.now() - IDLE_MS - 10, entries: [{ id: "y", kind: "user", text: "too old", photo: false, at: 1 }], room: null, preferences: null, shown: [], selected: null, ui: { open: false, view: "side" } };
    sessionStorage.setItem(sessionKey(SHOP), JSON.stringify(stale));
    const assistant = makeAssistant();
    assistant.open();
    expect($(".tryora-assistant__welcome")).not.toBeNull();
    expect(document.body.textContent).not.toContain("secret");
    expect(document.body.textContent).not.toContain("too old");
    expect(sessionStorage.getItem("tryora_assistant_context")).toBeNull();
  });

  it("shows an answer interrupted by navigation as stopped, with Retry", () => {
    sessionStorage.setItem(sessionKey(SHOP), JSON.stringify({
      v: 2, shop: SHOP, createdAt: Date.now(), updatedAt: Date.now(), room: null, preferences: null, shown: [], selected: null, ui: { open: true, view: "side" },
      entries: [
        { id: "u", kind: "user", text: "beds?", photo: false, at: 1 },
        { id: "a", kind: "assistant", text: "Half", status: "streaming", replyTo: "u", recommendations: [], visualise: null, at: 2 },
      ],
    }));
    makeAssistant().open();
    expect($(".tryora-assistant__failed")!.textContent).toMatch(/Stopped/);
    expect($("[data-ta='retry']")).not.toBeNull();
  });

  it("keeps working when browser storage is blocked", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    const assistant = makeAssistant();
    proxy.script([{ type: "final", reply: { message: "Still here.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("hi");
    click("[data-ta='send']");
    await settle(60);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe("Still here.");
  });
});

describe("product images in cards", () => {
  it("shows the supplied store currency on genuine product cards", async () => {
    await showCards([card({ price: "649.00", currencyCode: "EUR" })]);
    expect($(".tryora-assistant__card")!.textContent).toContain("649");
    expect($(".tryora-assistant__card")!.textContent).toContain("\u20ac");
    expect($(".tryora-assistant__card")!.textContent).not.toContain("\u00a3");
    expect($(".tryora-assistant__card [data-ta='preview']")!.textContent).toBe("Preview in my room");
  });
  it("keeps one short appearance reason and exact product link without displaying internal sizes or badges", async () => {
    const reason = "Cream fabric complements your neutral room. " + "Further description. ".repeat(20);
    await showCards([card({ options: { Colour: "Cream", Size: "King" }, reason, url: "/products/aria?variant=11" })]);
    const node = $(".tryora-assistant__card")!;
    expect(node.querySelector(".tryora-assistant__card-reason")!.textContent).toBe("Cream fabric complements your neutral room.");
    expect(node.textContent).not.toMatch(/King|Size|Further description/);
    expect(node.querySelectorAll(".tryora-assistant__badge")).toHaveLength(0);
    expect(node.querySelector(".tryora-assistant__card-actions a")!.getAttribute("href")).toBe("/products/aria?variant=11");
    expect(node.querySelector(".tryora-assistant__card-actions a")!.textContent).toBe("View details");
  });
  async function showCards(items: Record<string, unknown>[]) {
    const assistant = makeAssistant();
    proxy.script([{ type: "recommendations", items }], [{ type: "final", reply: { message: "Here you go.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Show me available beds");
    click("[data-ta='send']");
    await settle(60);
    return assistant;
  }

  it("shows four cards with their own descriptions, sends what was explored on show more, and keeps earlier batches", async () => {
    const reasons = [
      "Its oat linen picks up your warm beige walls and keeps the bright living room soft and relaxed.",
      "The natural oak top matches your wooden floor and anchors the seating area without crowding it.",
      "Ivory boucle adds texture beside the window and lifts the calm neutral palette you already have.",
      "A jute rug grounds the light floor and brings the woven, natural feel of your space together.",
    ];
    const titles = ["Linen Sofa", "Oak Table", "Boucle Armchair", "Jute Rug"];
    const batch = titles.map((title, i) => card({ id: `${i + 1}:`, productRef: String(i + 1), variantRef: null, productId: `gid://shopify/Product/${i + 1}`, title, reason: reasons[i] }));
    await showCards(batch);
    const first = [...document.querySelectorAll(".tryora-assistant__card")];
    expect(first).toHaveLength(4);
    // Each description sits inside its own card, in full, and matches that product.
    first.forEach((node, i) => {
      expect(node.querySelector("h4")!.textContent).toBe(titles[i]);
      expect(node.querySelector(".tryora-assistant__card-reason")!.textContent).toBe(reasons[i]);
    });
    proxy.script([{ type: "recommendations", items: [card({ id: "5:", productRef: "5", variantRef: null, productId: "gid://shopify/Product/5", title: "Walnut Media Unit",
      reason: "Warm walnut echoes the darker shelving and balances the pale walls in your living room nicely." })] }],
      [{ type: "final", reply: { message: "One more idea.", recommendations: [] } }, { type: "done" }]);
    await type("Show me more");
    click("[data-ta='send']");
    await settle(60);
    expect(JSON.parse(String(proxy.forms.at(-1)!.get("explored"))).map((entry: any) => entry.productRef)).toEqual(["1", "2", "3", "4"]);
    // The first batch stays in the conversation; the new card is added below it.
    expect([...document.querySelectorAll(".tryora-assistant__card h4")].map((h) => h.textContent)).toEqual([...titles, "Walnut Media Unit"]);
    const stored = JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!);
    expect(stored.explored.map((entry: any) => entry.productRef)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("View details goes to the product without reopening the assistant there, and the launcher still reopens it", async () => {
    await showCards([card({ url: "/products/aria?variant=11" })]);
    const stop = (event: Event) => event.preventDefault(); // jsdom cannot navigate; the real link would.
    document.addEventListener("click", stop);
    try {
      const link = $(".tryora-assistant__card [data-ta='view-details']") as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe("/products/aria?variant=11");
      // Ctrl/Cmd-click opens a new tab; this tab keeps its open assistant.
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
      expect(JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!).ui.open).toBe(true);
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } finally { document.removeEventListener("click", stop); }
    const stored = JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!);
    // The next page reads this flag on load; the conversation itself is kept.
    expect(stored.ui.open).toBe(false);
    expect(stored.entries.some((entry: any) => entry.kind === "assistant" && entry.recommendations?.length)).toBe(true);
    // The product page starts a fresh assistant: it does not open itself, and the launcher reopens the same conversation.
    document.body.innerHTML = "";
    expect(wasOpen(SHOP)).toBe(false);
    const productPage = makeAssistant();
    expect(document.querySelector(".tryora-assistant__panel:not([hidden])")).toBeNull();
    productPage.open();
    expect(JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!).ui.open).toBe(true);
    expect($$(".tryora-assistant__card h4").map((h) => h.textContent)).toEqual(["Aria Bed"]);
  });

  it("renders the real Shopify thumbnail with alt text, a loading state and a loaded state", async () => {
    await showCards([card({ image: "https://cdn.shopify.com/s/files/chelsea.jpg", imageAlt: "Chelsea Luxe Bed in grey", imageSource: "product", variantRef: null })]);
    const thumb = $(".tryora-assistant__card .tryora-assistant__thumb")!;
    const image = thumb.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("https://cdn.shopify.com/s/files/chelsea.jpg");
    expect(image.getAttribute("alt")).toBe("Chelsea Luxe Bed in grey");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(thumb.dataset.state).toBe("loading");
    image.dispatchEvent(new Event("load"));
    expect(thumb.dataset.state).toBe("loaded");
    // A product-level card's featured photo needs no caveat.
    expect(thumb.querySelector(".tryora-assistant__thumb-note")).toBeNull();
  });

  it("replaces a failed image with a text state, and shows text, never stock art, when there is no image", async () => {
    await showCards([card(), card({ id: "2:", productRef: "2", variantRef: null, title: "Thames Bed Frame", image: null, imageSource: null, previewAvailable: false, previewStatus: "not_configured", optionValue: null })]);
    const [first, second] = $$(".tryora-assistant__card .tryora-assistant__thumb");
    first!.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(first!.dataset.state).toBe("error");
    expect(first!.textContent).toBe("Image unavailable");
    expect(first!.getAttribute("aria-label")).toMatch(/^Image unavailable/);
    expect(second!.classList.contains("is-missing")).toBe(true);
    expect(second!.textContent).toBe("No image");
    expect(second!.querySelector("svg, img")).toBeNull();
  });

  it("labels a general product photo shown for a specific option and the preview reference", async () => {
    await showCards([
      card({ id: "3:31", title: "Egerie Bed", options: { Fabric: "Grey Velvet" }, image: "https://cdn.shopify.com/featured.jpg", imageSource: "product", previewAvailable: false, previewStatus: "unavailable", optionValue: null }),
      card({ id: "3:32", title: "Egerie Bed", options: { Fabric: "Grey Velvet" }, image: "https://cdn.shopify.com/approved.jpg", imageSource: "reference", referenceImage: "https://cdn.shopify.com/approved.jpg" }),
    ]);
    const [general, reference] = $$(".tryora-assistant__card");
    expect(general!.querySelector(".tryora-assistant__thumb-note")!.textContent).toBe("Product photo");
    expect(general!.textContent).toContain("Photo shows the product; your selected option may look different.");
    // Not verifiable for a preview: the action is shown disabled, with the reason.
    const disabled = general!.querySelector<HTMLButtonElement>(".tryora-assistant__card-actions button[aria-describedby]")!;
    expect(disabled.disabled).toBe(true);
    expect(general!.querySelector(`#${CSS.escape(disabled.getAttribute("aria-describedby")!)}`)!.textContent).toBe("This exact option isn't approved for AI room preview.");
    expect(reference!.querySelector(".tryora-assistant__thumb-note")!.textContent).toBe("Preview reference");
    expect(reference!.querySelector("[data-ta='preview']")).not.toBeNull();
  });

  it("shows the approved reference on the preview card and never sends image URLs for generation", async () => {
    const assistant = makeAssistant();
    const item = card({ image: "https://cdn.shopify.com/variant.jpg", imageSource: "variant", referenceImage: "https://cdn.shopify.com/approved-reference.jpg" });
    proxy.script([{ type: "visualise", item }], [{ type: "final", reply: { message: "Confirm to preview.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await attachFile();
    await type("Show it in my room");
    click("[data-ta='send']");
    await settle(60);
    const visual = $(".tryora-assistant__visualise")!;
    expect(visual.querySelector("img")!.getAttribute("src")).toBe("https://cdn.shopify.com/approved-reference.jpg");
    expect(visual.querySelector(".tryora-assistant__thumb-note")!.textContent).toBe("Preview reference");
    click(".tryora-assistant__visualise [data-ta='preview']");
    await settle(1500);
    const start = proxy.calls.find((call) => call.url === "/apps/tryora/preview")!;
    // The server re-resolves the approved reference itself; the browser only names the exact product and variant.
    expect([...start.body!.keys()].sort()).toEqual(["key", "leadDone", "mappingRevision", "option", "photo", "product", "sourceVariant", "variant", "visitor"]);
    expect(JSON.stringify([...start.body!.entries()].filter(([, value]) => typeof value === "string"))).not.toContain("cdn.shopify.com");
  });
});

describe("in-card options and conversation memory", () => {
  const variant = (ref: string, fabric: string, colour: string, size: string, extra: Record<string, unknown> = {}) => ({
    ref, id: `gid://shopify/ProductVariant/${ref}`, values: { Fabric: fabric, Colour: colour, Size: size },
    options: { Fabric: fabric, Colour: colour, Size: size }, price: size === "King" ? "899.00" : "799.00", available: true,
    image: `https://cdn.shopify.com/egerie-${ref}.jpg`, previewOption: null, ...extra,
  });
  const egerieOptions = () => ({
    productRef: "3", productId: "gid://shopify/Product/3", title: "Egerie Bed", url: "/products/egerie", image: "https://cdn.shopify.com/egerie.jpg", imageAlt: null, currencyCode: "GBP", singleVariant: false,
    preview: { offered: true, reason: null },
    attributes: [
      { name: "Fabric", kind: "fabric", values: [{ value: "Boucle", colour: null, image: null }, { value: "Velvet", colour: null, image: null }] },
      { name: "Colour", kind: "colour", values: [{ value: "Beige", colour: "#d8c6ae", image: null }, { value: "Grey", colour: "#8a8a8a", image: null }, { value: "Emerald", colour: "#2f6b4f", image: null }] },
      { name: "Size", kind: "size", values: [{ value: "Double", colour: null, image: null }, { value: "King", colour: null, image: null }] },
    ],
    variants: [
      variant("31", "Boucle", "Beige", "Double"), variant("32", "Boucle", "Beige", "King", { previewOption: "Beige" }),
      variant("33", "Boucle", "Grey", "King", { available: false }), variant("34", "Velvet", "Emerald", "King", { image: null }),
    ],
  });
  const egerieCard = () => card({ id: "3:", productRef: "3", variantRef: null, productId: "gid://shopify/Product/3", variantId: null, title: "Egerie Bed", url: "/products/egerie", options: {},
    image: "https://cdn.shopify.com/egerie.jpg", imageSource: "product", price: "799.00", maxPrice: "899.00", previewAvailable: false, previewStatus: "choose_options",
    previewReason: "Choose the fabric, colour and size to check AI room preview.", optionValue: null, hasOptions: true, variantCount: 4 });

  async function showCards(items: any[], overrides: Record<string, unknown> = {}) {
    const assistant = makeAssistant({}, overrides);
    proxy.script([{ type: "recommendations", items }], [{ type: "final", reply: { message: "Here you go.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("beds?");
    click("[data-ta='send']");
    await settle(60);
    return assistant;
  }
  const opt = (attr: string, value: string) => $(`[data-ta='opt'][data-attr='${attr}'][data-value='${value}']`) as HTMLButtonElement | null;
  const choose = (attr: string, value: string) => click(`[data-ta='opt'][data-attr='${attr}'][data-value='${value}']`);

  it("shows no artificial options for a single-variant bed", async () => {
    await showCards([card({ id: "5:51", productRef: "5", variantRef: "51", title: "Thames Bed Frame", options: {}, hasOptions: false, variantCount: 1 })]);
    const thames = $(".tryora-assistant__card")!;
    expect(thames.querySelector("[data-ta='options']")).toBeNull();
    expect(thames.querySelectorAll(".tryora-assistant__tag")).toHaveLength(0);
    expect(thames.querySelector("[data-ta='preview']")).not.toBeNull();
    expect(thames.textContent).not.toMatch(/Default Title|Choose options/);
  });

  it("refines appearance while preserving the established exact Shopify configuration", async () => {
    proxy.options = egerieOptions();
    await showCards([{ ...egerieCard(), variantRef: "32", variantId: "gid://shopify/ProductVariant/32" }]);
    expect($(".tryora-assistant__card")!.textContent).toContain("Egerie Bed");
    await settle(30);
    await settle(30);
    expect(proxy.calls.some((call) => call.url.startsWith("/apps/tryora/assistant/options?product=gid%3A%2F%2Fshopify%2FProduct%2F3&visitor="))).toBe(true);
    // Colours follow the fabric family; values with no variant are disabled; sold-out ones are marked.
    choose("Fabric", "Velvet");
    expect(opt("Colour", "Beige")).toBeNull();
    expect(opt("Colour", "Emerald")).not.toBeNull();
    choose("Fabric", "Boucle");
    expect(opt("Colour", "Emerald")).toBeNull();
    expect(opt("Colour", "Grey")!.querySelector("i")!.getAttribute("style")).toBe("background:#8a8a8a");
    choose("Colour", "Grey");
    expect(opt("Size", "Double")).toBeNull();
    expect(opt("Size", "King")).toBeNull();
    expect(opt("Colour", "Grey")!.classList.contains("is-soldout")).toBe(true);
    choose("Colour", "Beige");
    // The exact selection is confirmed by the same server validation as /preview before the button is offered.
    expect($(".tryora-assistant__card")!.textContent).toContain("Checking AI room preview for this option");
    await settle(30);
    expect(proxy.calls.some((call) => call.url.startsWith("/apps/tryora/assistant/preview-check?product=gid%3A%2F%2Fshopify%2FProduct%2F3&variant=gid%3A%2F%2Fshopify%2FProductVariant%2F32"))).toBe(true);
    expect($(".tryora-assistant__options [role='status']")).toBeNull();
    const egerie = $(".tryora-assistant__card")!;
    expect(egerie.querySelector(".tryora-assistant__price")!.textContent).toMatch(/899\.00/);
    expect(egerie.querySelector(".tryora-assistant__thumb img")!.getAttribute("src")).toBe("https://cdn.shopify.com/egerie-32.jpg");
    expect(egerie.querySelector("[data-ta='preview']")).not.toBeNull();
    expect(egerie.classList.contains("is-selected")).toBe(true);
    expect(egerie.querySelector("a")!.getAttribute("href")).toBe("/products/egerie?variant=32");
    // The exact selection is remembered and sent with the next message.
    const stored = JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!);
    expect(stored.selected).toEqual({ productRef: "3", variantRef: "32", source: "options" });
    proxy.script([{ type: "final", reply: { message: "Yes.", recommendations: [] } }, { type: "done" }]);
    await type("Is that one comfortable?");
    click("[data-ta='send']");
    await settle(60);
    expect(JSON.parse(String(proxy.forms.at(-1)!.get("selected")))).toEqual({ productRef: "3", variantRef: "32", source: "options" });
    expect(JSON.parse(String(proxy.forms.at(-1)!.get("shown")))).toEqual([{ productRef: "3", variantRef: "32" }]);
  });

  it("never invents an unselected hidden configuration", async () => {
    proxy.options = egerieOptions(); await showCards([egerieCard()]);
    await settle(30);
    choose("Fabric", "Boucle"); choose("Colour", "Beige");
    expect(opt("Size", "King")).toBeNull();
    expect($(".tryora-assistant__options [role='status']")!.textContent).toContain("No configuration has been chosen automatically");
    expect($(".tryora-assistant__card [data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(proxy.calls.some((c) => c.url === "/apps/tryora/preview")).toBe(false);
  });

  it("retains the selected size on a fabric change and cannot preview the old variant while colour is incomplete", async () => {
    proxy.options = egerieOptions();
    const chosen = { ...egerieCard(), variantRef: "32", variantId: "gid://shopify/ProductVariant/32", options: { Fabric: "Boucle", Colour: "Beige", Size: "King" }, previewAvailable: true, previewStatus: "available", optionValue: "Beige" };
    const assistant = await showCards([chosen]); await settle();
    choose("Fabric", "Velvet");
    expect(opt("Size", "King")).toBeNull();
    expect([...assistant.cardOptions.values()][0].selections.Size).toBe("King");
    expect(opt("Colour", "Emerald")!.getAttribute("aria-pressed")).toBe("false");
    expect($(".tryora-assistant__card [data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
    expect($(".tryora-assistant__card")!.textContent).toContain("Select a colour to preview.");
  });
  it("shows the server's precise reason and never offers a preview the exact-variant check refuses", async () => {
    proxy.options = egerieOptions();
    proxy.check = { variantId: "gid://shopify/ProductVariant/32", previewAvailable: false, previewStatus: "unavailable", optionValue: null, referenceImage: null,
      previewReason: "The store hasn't approved a photo of this exact option for AI room preview yet." };
    await showCards([{ ...egerieCard(), variantRef: "32", variantId: "gid://shopify/ProductVariant/32" }]);
    await settle(30);
    choose("Fabric", "Boucle"); choose("Colour", "Beige"); await settle(30);
    const egerie = $(".tryora-assistant__card")!;
    expect(egerie.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(egerie.textContent).toContain("The store hasn't approved a photo of this exact option for AI room preview yet.");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
  });

  it("never enables Preview for an earlier choice whose check finishes after the shopper changed fabric", async () => {
    proxy.options = egerieOptions();
    await showCards([{ ...egerieCard(), variantRef: "32", variantId: "gid://shopify/ProductVariant/32" }]);
    await settle(30);
    let release!: () => void; proxy.checkGate = new Promise<void>((resolve) => { release = resolve; });
    choose("Colour", "Beige"); // Boucle / Beige / King: its eligibility check is now pending.
    choose("Fabric", "Velvet"); // Colour cleared: the selection is incomplete while that check is still open.
    release(); proxy.checkGate = null; await settle(30);
    const card = $(".tryora-assistant__card")!;
    expect(card.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(card.textContent).toContain("Select a colour to preview.");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
  });

  it("applies only the newest check when the shopper switches between two variants", async () => {
    const options = egerieOptions();
    options.variants.push({ ...options.variants[1]!, ref: "35", id: "gid://shopify/ProductVariant/35", values: { Fabric: "Velvet", Colour: "Beige", Size: "King" }, options: { Fabric: "Velvet", Colour: "Beige", Size: "King" }, previewOption: "Beige" } as any);
    proxy.options = options;
    // The first variant would be previewable; the second is refused. The refusal must win, whatever order replies arrive in.
    proxy.check = (variantId: string) => variantId.endsWith("/35")
      ? { variantId, previewAvailable: false, previewStatus: "unavailable", optionValue: null, referenceImage: null, previewReason: "The store hasn't approved a photo of this exact option for AI room preview yet." }
      : null;
    await showCards([{ ...egerieCard(), variantRef: "32", variantId: "gid://shopify/ProductVariant/32" }]);
    await settle(30);
    let release!: () => void; proxy.checkGate = new Promise<void>((resolve) => { release = resolve; });
    choose("Colour", "Beige");
    choose("Fabric", "Velvet"); choose("Colour", "Beige");
    release(); proxy.checkGate = null; await settle(40);
    const card = $(".tryora-assistant__card")!;
    expect(card.querySelector("a")!.getAttribute("href")).toBe("/products/egerie?variant=35");
    expect(card.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(card.textContent).toContain("The store hasn't approved a photo of this exact option");
  });

  it("checks and enables the only purchasable configuration without asking the shopper to choose", async () => {
    const options = egerieOptions();
    options.variants = options.variants.map((v: any) => ({ ...v, available: v.ref === "32" }));
    proxy.options = options;
    await showCards([egerieCard()]);
    await settle(40);
    const card = $(".tryora-assistant__card")!;
    expect(card.querySelector("a")!.getAttribute("href")).toBe("/products/egerie?variant=32");
    expect(card.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(false);
    expect(proxy.calls.some((call) => call.url.includes("/assistant/preview-check?") && call.url.includes("ProductVariant%2F32"))).toBe(true);
    // Nothing was chosen by the shopper, so nothing is recorded as their selection.
    expect(JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!).selected).toBeNull();
  });

  it("keeps preview disabled, with the reason, for an option that is not approved", async () => {
    proxy.options = egerieOptions();
    await showCards([{ ...egerieCard(), variantRef: "31", variantId: "gid://shopify/ProductVariant/31" }]);
    await settle(30);
    await settle(30);
    choose("Fabric", "Boucle");
    choose("Colour", "Beige");
    expect(opt("Size", "Double")).toBeNull();
    const egerie = $(".tryora-assistant__card")!;
    expect(egerie.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    // Other verified appearances are already on the card; there is no second competing button.
    expect(egerie.querySelector(".tryora-assistant__card-choices .tryora-assistant__options")).not.toBeNull();
    expect([...egerie.querySelectorAll(".tryora-assistant__card-actions > *")].map((node) => node.textContent)).toEqual(["View details", "Preview in my room"]);
    expect(egerie.textContent).toContain("This exact option isn't approved for AI room preview.");
  });

  it("disables previews with a clear reason when the store has no preview credits", async () => {
    await showCards([card()], { previewsAvailable: false });
    const item = $(".tryora-assistant__card")!;
    expect(item.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
    expect(item.textContent).toContain("New AI previews are temporarily unavailable.");
  });

  it("sends older shopper messages as bounded reminders in long conversations", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => i % 2
      ? { id: `a${i}`, kind: "assistant", text: `Answer ${i}`, status: "done", replyTo: `u${i - 1}`, recommendations: [], visualise: null, at: i }
      : { id: `u${i}`, kind: "user", text: `Question ${i} ${"z".repeat(300)}`, photo: false, at: i });
    sessionStorage.setItem(sessionKey(SHOP), JSON.stringify({ v: 2, shop: SHOP, createdAt: Date.now(), updatedAt: Date.now(), entries, room: null, preferences: null, shown: [], selected: null, ui: { open: false, view: "side" }, lead: { done: false }, previewsDelivered: 0 }));
    const assistant = makeAssistant();
    proxy.script([{ type: "final", reply: { message: "Ok.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("And now?");
    click("[data-ta='send']");
    await settle(60);
    const form = proxy.forms[0]!;
    expect(JSON.parse(String(form.get("history")))).toHaveLength(12);
    const earlier = JSON.parse(String(form.get("earlier")));
    expect(earlier).toHaveLength(6);
    expect(earlier.every((text: string) => text.length <= 160 && text.startsWith("Question"))).toBe(true);
  });

  it("New chat keeps the completed email step; Clear conversation forgets it", async () => {
    sessionStorage.setItem(sessionKey(SHOP), JSON.stringify({ v: 2, shop: SHOP, createdAt: Date.now(), updatedAt: Date.now(), entries: [], room: null, preferences: null, shown: [], selected: null, ui: { open: false, view: "side" }, lead: { done: true }, previewsDelivered: 1 }));
    const assistant = makeAssistant();
    assistant.open();
    assistant.newChat();
    expect(JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!).lead).toEqual({ done: true });
    assistant.clearConversation();
    const kept = JSON.parse(sessionStorage.getItem(sessionKey(SHOP)) ?? "{}");
    expect(kept.lead).toEqual({ done: false });
    expect(kept.previewsDelivered).toBe(0);
  });
});

describe("conversation state: selection, constraints and shown products", () => {
  const cloud = card({ id: "2:21", productRef: "2", variantRef: "21", title: "Cloud Nine Upholstered kids", url: "/products/cloud-nine?variant=21", image: "https://cdn.shopify.com/cloud.jpg",
    price: "239.99", previewAvailable: false, previewStatus: "not_configured", previewReason: "AI room preview isn't offered for this product.", optionValue: null });
  const egerie = card({ id: "3:31", productRef: "3", variantRef: "31", title: "Egerie Bed", price: "319.99" });
  async function turn(events: any[], final: Record<string, unknown> = {}, text = "beds?") {
    proxy.script(...(events.length ? [events] : []), [{ type: "final", reply: { message: "OK.", recommendations: [], ...final } }, { type: "done" }]);
    await type(text);
    click("[data-ta='send']");
    await settle(80);
  }

  it("Scenario A: pressing Preview in my room makes that card the authoritative selection sent with the next message", async () => {
    makeAssistant().open();
    await turn([{ type: "recommendations", items: [cloud, egerie] }]);
    const cards = $$(".tryora-assistant__card");
    expect(cards.map((element) => element.querySelector(".tryora-assistant__eyebrow")!.textContent)).toEqual(["Recommended for your room \u00b7 Option 1", "Recommended for your room \u00b7 Option 2"]);
    // Two actions only: no separate "Select this look" or appearance link competing with them.
    expect(cards.every((card) => [...card.querySelectorAll("button, a")].map((node) => node.textContent).join("|") === "View details|Preview in my room")).toBe(true);
    cards[1]!.querySelector<HTMLButtonElement>("[data-ta='preview']")!.click();
    await settle(10);
    const selected = $$(".tryora-assistant__card")[1]!;
    expect(selected.classList.contains("is-selected")).toBe(true);
    expect(selected.querySelector(".tryora-assistant__eyebrow")!.textContent).toBe("Selected for your room \u00b7 Option 2");
    await turn([], {}, "select one");
    expect(JSON.parse(String(proxy.forms.at(-1)!.get("selected")))).toEqual({ productRef: "3", variantRef: "31", source: "card" });
  });

  it("Scenario D: 'show me Cloud Nine' renders that product's card with its photo even when it can't be previewed", async () => {
    makeAssistant().open();
    await turn([{ type: "selected", item: cloud, source: "conversation" }], { selection: { productRef: "2", variantRef: "21", source: "conversation" } }, "Show me Cloud Nine");
    const shown = $$(".tryora-assistant__card");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.querySelector(".tryora-assistant__eyebrow")!.textContent).toBe("Selected for your room \u00b7 Option 1");
    expect(shown[0]!.querySelector(".tryora-assistant__thumb img")!.getAttribute("src")).toBe("https://cdn.shopify.com/cloud.jpg");
    expect(shown[0]!.querySelector("a")!.getAttribute("href")).toBe("/products/cloud-nine?variant=21");
    expect(shown[0]!.querySelector("[data-ta='preview']")!.hasAttribute("disabled")).toBe(true);
  });

  it("persists the budget the server returns and sends it back on later turns, until a new chat", async () => {
    const assistant = makeAssistant();
    assistant.open();
    const constraints = { budgetMax: 250, budgetMin: null, budgetCurrency: "$", forChildren: false };
    await turn([{ type: "constraints", constraints }], { constraints }, "my budget 250$");
    expect(JSON.parse(sessionStorage.getItem(sessionKey(SHOP))!).constraints).toEqual(constraints);
    await turn([], {}, "show me grey ones");
    expect(JSON.parse(String(proxy.forms.at(-1)!.get("constraints")))).toEqual(constraints);
    assistant.newChat();
    await turn([], {}, "hello");
    expect(proxy.forms.at(-1)!.get("constraints")).toBeNull();
  });

  it("older cards take the newest verified preview status, so two cards never disagree", async () => {
    makeAssistant().open();
    await turn([{ type: "recommendations", items: [egerie, cloud] }]);
    const ready = { ...cloud, previewAvailable: true, previewStatus: "available", previewReason: null, optionValue: "__single__" };
    await turn([{ type: "selected", item: ready, source: "conversation" }], {}, "Show me Cloud Nine");
    const oldCloud = $$(".tryora-assistant__card")[1]!;
    expect(oldCloud.querySelector("h4")!.textContent).toBe("Cloud Nine Upholstered kids");
    expect(oldCloud.querySelector("[data-ta='preview']")).not.toBeNull();
  });
});


describe("approved photo entry points", () => {
  it("keeps cards clean and adapts to the verified category", () => {
    const assistant = makeAssistant(); assistant.open();
    expect($("[data-action='visualise']")!.textContent).toContain("Preview this bed in my room");
    expect($("[data-action='recommend']")!.textContent).toContain("Recommend a bed for my room");
    expect($(".tryora-assistant__actions-grid [data-ta='upload']")).toBeNull();
    expect($(".tryora-assistant__actions-grid [data-ta='camera']")).toBeNull();
    expect($("[data-ta='attach'] svg")).not.toBeNull();
  });
  it("back and ask preserve conversation, room, selection and draft", async () => {
    const assistant = makeAssistant(); assistant.open();
    assistant.state.entries = [{ id: "old", kind: "notice", text: "Keep conversation", at: Date.now() }];
    assistant.state.selected = { productRef: "9", variantRef: "91", source: "card" };
    assistant.state.room = { colours: ["cream"], style: "calm" };
    await type("Keep draft");
    const before = JSON.stringify(assistant.state);
    assistant.welcomeAction("recommend");
    expect($$(".tryora-assistant__photo-actions button").map((b) => b.dataset.ta)).toEqual(["camera", "upload"]);
    click("[data-ta='photo-back']");
    expect($(".tryora-assistant__welcome")).not.toBeNull();
    assistant.welcomeAction("ask");
    expect($(".tryora-assistant__scroll")!.textContent).toContain("Keep conversation");
    expect(JSON.stringify(assistant.state)).toBe(before);
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("Keep draft");
  });
  it("explains desktop camera fallback without an unexpected file picker", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const assistant = makeAssistant(); assistant.open(); click("[data-action='visualise']");
    const upload = vi.spyOn($("[data-ta-file='upload']")!, "click");
    const camera = vi.spyOn($("[data-ta-file='camera']")!, "click");
    click("[data-ta='camera']");
    expect($(".tryora-assistant__camera-notice")!.textContent).toContain("Choose Upload photo");
    expect(camera).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    click("[data-ta='upload']"); expect(upload).toHaveBeenCalledOnce();
  });
  it("uses a native rear camera input and preserves cancelled capture state", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const assistant = makeAssistant(); assistant.open(); click("[data-action='recommend']");
    const input = $("[data-ta-file='camera']") as HTMLInputElement;
    const picker = vi.spyOn(input, "click"); click("[data-ta='camera']");
    expect(picker).toHaveBeenCalledOnce();
    expect(input.getAttribute("capture")).toBe("environment");
    expect(input.getAttribute("accept")).toBe("image/*");
    Object.defineProperty(input, "files", { value: [] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(assistant.attachment).toBeNull();
    expect($(".tryora-assistant__photo-screen")).not.toBeNull();
    expect(proxy.forms).toHaveLength(0);
  });
  it("shows invalid-file errors on the photo screen and allows retry", async () => {
    const { PhotoError } = await import("../../packages/storefront/src/assistant/photo");
    const prepare = vi.fn().mockRejectedValueOnce(new PhotoError("Please choose a JPG room photo.")).mockResolvedValueOnce(photo());
    const assistant = makeAssistant({ preparePhoto: prepare }); assistant.open(); click("[data-action='recommend']");
    await attachFile("bad.pdf", "application/pdf");
    expect($(".tryora-assistant__photo-screen [role='alert']")!.textContent).toContain("Please choose");
    expect(assistant.attachment).toBeNull(); expect(proxy.forms).toHaveLength(0);
    await attachFile();
    expect($(".tryora-assistant__photo-screen")).toBeNull();
    expect($("[data-ta-attachment] img")).not.toBeNull();
  });
  it("sends a composer photo with text without forcing preview generation", async () => {
    const assistant = makeAssistant(); assistant.open();
    click("[data-action='visualise']"); click("[data-ta='photo-back']"); click("[data-ta='attach']");
    expect($(".tryora-assistant__menu--attach h3")!.textContent).toBe("Add a photo to your message");
    expect(document.activeElement).toBe($("[data-ta='photo-sheet-close']"));
    proxy.script([{ type: "final", reply: { message: "Cream could suit the room.", recommendations: [] } }, { type: "done" }]);
    await attachFile();
    expect(assistant.pendingIntent).toBeNull();
    expect($(".tryora-assistant__menu--attach")!.hidden).toBe(true);
    await type("This is my room. What colour would suit it?");
    click("[data-ta='send']"); await settle(60);
    expect(proxy.forms[0]!.get("photo")).toBeInstanceOf(Blob);
    expect(String(proxy.forms[0]!.get("history"))).toContain("What colour would suit it?");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
  });
  it("discards a prepared image arriving after Forget room", async () => {
    let resolve!: (value: ReturnType<typeof photo>) => void;
    const assistant = makeAssistant({ preparePhoto: () => new Promise((done) => { resolve = done; }) });
    assistant.open();
    const pending = assistant.attach(new File(["x"], "room.jpg", { type: "image/jpeg" }));
    assistant.forgetRoom(); resolve(photo("late.jpg")); await pending;
    expect(assistant.attachment).toBeNull(); expect(assistant.roomPhoto).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:late.jpg");
  });
  it("Escape closes the photo sheet and restores camera-button focus", () => {
    const assistant = makeAssistant(); assistant.open(); click("[data-ta='attach']");
    $("[data-ta='photo-sheet-close']")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".tryora-assistant__menu--attach")!.hidden).toBe(true);
    expect(document.activeElement).toBe($("[data-ta='attach']")); expect(assistant.isOpen).toBe(true);
  });
  it("asks the shopper to select furniture when there is no known current product", async () => {
    const assistant = makeAssistant({ productId: undefined, productNoun: undefined, openCurrentPreview: undefined });
    proxy.script([{ type: "final", reply: { message: "Here are store products.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    expect($("[data-action='visualise']")!.textContent).toContain("Select furniture to preview");
    expect($("[data-action='recommend']")!.textContent).toContain("Recommend furniture");
    click("[data-action='visualise']"); await settle(60);
    expect(proxy.forms).toHaveLength(0); expect($(".tryora-assistant__photo-screen")).toBeNull();
    expect($(".tryora-assistant__notice")!.textContent).toContain("Please select a furniture product");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
  });
});


describe("catalogue welcome copy without question chips", () => {
  it("updates only verified recommendation copy without losing the composer draft or enabling a homepage preview", async () => {
    proxy.recommendation = { noun: "sofa", fabric: true, colour: false };
    const assistant = makeAssistant({ productId: undefined, productNoun: undefined, openCurrentPreview: undefined });
    assistant.open();
    await type("My room has an oak floor");
    await settle();
    expect($("[data-ta-recommend-title]")!.textContent).toBe("Recommend a sofa for my room");
    expect($("[data-ta-recommend-description]")!.textContent).toBe("Find the best sofa and fabric for your room.");
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("My room has an oak floor");
    expect($$("[data-ta='welcome']")).toHaveLength(2);
    expect($("[data-action='ask']")).toBeNull();
    expect($("[data-action='visualise']")!.textContent).toContain("Select furniture to preview");
    expect(proxy.forms).toHaveLength(0);
  });
  it("offers the approved bed copy only when native fabric and colour evidence is supplied", async () => {
    proxy.recommendation = { noun: "bed", fabric: true, colour: true };
    const assistant = makeAssistant(); assistant.open(); await settle();
    expect($("[data-action='visualise'] small")!.textContent).toBe("See how this bed looks in your own space.");
    expect($("[data-ta-recommend-description]")!.textContent).toBe("Find the best bed, fabric and colour for your room.");
    expect($("[data-action='ask']")).toBeNull();
    expect($(".tryora-assistant__welcome")!.textContent).not.toContain("Ask about products");
  });
  it("ignores invalid welcome metadata and does not add unsupported appearance choices", async () => {
    proxy.recommendation = { noun: "<script>bed</script>", fabric: true, colour: true };
    const assistant = makeAssistant({ productId: undefined, productNoun: undefined, openCurrentPreview: undefined });
    assistant.open(); await settle();
    expect($("[data-ta-recommend-description]")!.textContent).toBe("Find the best furniture for your room.");
    expect($(".tryora-assistant__welcome script")).toBeNull();
  });

  it("never renders question chips, even if an older backend supplies suggestions", async () => {
    proxy.suggestions = ["Tell me about Aria Bed", "What sizes are available?", "What is your returns policy?"];
    const assistant = makeAssistant(); assistant.open(); await settle();
    expect($$(".tryora-assistant__suggestion, [data-ta='suggest'], [data-ta-suggestions]")).toHaveLength(0);
    expect($$("[data-ta='welcome']").map((button) => button.dataset.action)).toEqual(["visualise", "recommend"]);
    expect($(".tryora-assistant__welcome")!.textContent).not.toMatch(/Tell me about|What sizes|returns policy/);
    expect(proxy.forms).toHaveLength(0);
    const call = proxy.calls.find((c) => c.url.includes("/assistant/suggestions?"))!;
    expect(new URL(call.url, "https://example.com").searchParams.get("product")).toBe("1");
  });
  it("shows no generic bed/sofa/policy suggestions without catalogue evidence", async () => {
    const assistant = makeAssistant(); assistant.open(); await settle();
    expect($$(".tryora-assistant__suggestion")).toHaveLength(0);
    expect($(".tryora-assistant__welcome")!.textContent).not.toMatch(/grey beds|velvet sofas|returns policy/i);
    expect($("textarea")).not.toBeNull();
  });
});


describe("managed preview transport", () => {
  it("sends the exact reviewed revision and source variant through the existing preview backend", async () => {
    const item = card({ previewContext: { mappingRevision: "reviewed-revision", sourceVariantId: "gid://shopify/ProductVariant/11" } });
    const assistant = makeAssistant(); assistant.open(); await attachFile();
    proxy.script([{ type: "visualise", item }], [{ type: "final", reply: { message: "Confirm this exact reference.", recommendations: [] } }, { type: "done" }]);
    await type("Show this in my room"); click("[data-ta='send']"); await settle(60);
    click(".tryora-assistant__visualise [data-ta='preview']"); await settle(1500);
    const posted = proxy.calls.find((call) => call.url === "/apps/tryora/preview")!.body!;
    expect(posted.get("mappingRevision")).toBe("reviewed-revision");
    expect(posted.get("sourceVariant")).toBe("gid://shopify/ProductVariant/11");
    expect(posted.get("variant")).toBe("gid://shopify/ProductVariant/11");
    expect($(".tryora-assistant__preview [download]")).not.toBeNull();
  });
  it("does not start a managed preview after its captured Shopify page configuration changes", async () => {
    const assistant = makeAssistant({ currentVariantId: () => "12" }); assistant.open();
    await assistant.startPreview(card({ previewContext: { mappingRevision: "r", sourceVariantId: "gid://shopify/ProductVariant/11", pageSourceVariantId: "gid://shopify/ProductVariant/11" } }));
    expect($(".tryora-assistant__notice")!.textContent).toContain("Shopify configuration changed");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
  });
});

describe("chat card popup handoff", () => {
  const result = () => ({
    jobId: "popup-job", productId: "gid://shopify/Product/1", title: "Aria Bed", variantId: "gid://shopify/ProductVariant/11",
    optionValue: "Cream", selectionLabel: "Velvet / Cream", selectedOptions: { Fabric: "Velvet", Colour: "Cream", Size: "King" },
    image: new Blob(["image"], { type: "image/jpeg" }), room: new Blob(["room"], { type: "image/jpeg" }), leadDone: true,
  });
  it("keeps the welcome preview in chat and retains guarded legacy delivery compatibility", () => {
    const launch = vi.fn();
    const assistant = makeAssistant({ openAssistantPreview: launch });
    assistant.open(); click("[data-action='visualise']");
    expect(assistant.isOpen).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect($(".tryora-assistant__photo-screen")).not.toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
    const epoch = assistant.conversationEpoch;
    const hooks = { deliver: (value: any) => assistant.receivePopupPreview(value, epoch) };
    expect(assistant.isOpen).toBe(true);
    assistant.state.room = { colours: ["old red"], style: "old room" };
    assistant.attachment = photo("old-draft.jpg");
    expect(hooks.deliver(result())).toBe(true);
    expect(assistant.state.room).toBeNull();
    expect(assistant.attachment).toBeNull();
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    expect($(".tryora-assistant__preview")!.textContent).toContain("Aria Bed");
    expect(assistant.state.selected).toEqual({ productRef: "1", variantRef: "11", source: "options" });
    expect(assistant.state.entries.filter((e: any) => e.kind === "preview")).toHaveLength(1);
    expect(hooks.deliver(result())).toBe(true);
    expect(assistant.state.entries.filter((e: any) => e.kind === "preview")).toHaveLength(1);
    assistant.newChat();
    expect(hooks.deliver({ ...result(), jobId: "stale-job" })).toBe(false);
    expect($(".tryora-assistant__preview img")).toBeNull();
    click("[data-ta='product-preview']");
    expect(openPreview).toHaveBeenCalledOnce(); // Explicit fallback link keeps the original local-result flow.
  });
  it("rejects wrong-product and forgotten-room deliveries without displaying an image", () => {
    const launch = vi.fn(); const assistant = makeAssistant({ openAssistantPreview: launch });
    assistant.open(); click("[data-action='visualise']");
    const epoch = assistant.conversationEpoch;
    const hooks = { deliver: (value: any) => assistant.receivePopupPreview(value, epoch) };
    expect(hooks.deliver({ ...result(), productId: "gid://shopify/Product/999" })).toBe(false);
    assistant.forgetRoom();
    expect(hooks.deliver(result())).toBe(false);
    expect(assistant.state.previewsDelivered).toBe(0);
  });
});


describe("preview entry requires an eligible page product", () => {
  it("blocks an unsupported page product without opening a picker, popup or model request", async () => {
    const assistant = makeAssistant({ productId: "99", productNoun: undefined, openCurrentPreview: undefined, openAssistantPreview: undefined });
    assistant.open();
    expect($("[data-action='visualise']")!.textContent).toContain("Select furniture to preview");
    const picker = vi.spyOn($("[data-ta-file='upload']")!, "click");
    click("[data-action='visualise']"); await settle();
    expect($(".tryora-assistant__notice")!.textContent).toContain("Please select a furniture product");
    expect(picker).not.toHaveBeenCalled(); expect(openPreview).not.toHaveBeenCalled();
    expect(proxy.forms).toHaveLength(0);
    expect(assistant.isOpen).toBe(true);
    expect(document.activeElement).toBe($("textarea"));
  });
  it("does not open a supplied popup hook without a current product identity", () => {
    const popup = vi.fn();
    const assistant = makeAssistant({ productId: undefined, openAssistantPreview: popup, openCurrentPreview: undefined });
    assistant.open(); click("[data-action='visualise']");
    expect(popup).not.toHaveBeenCalled();
    expect($(".tryora-assistant__notice")!.textContent).toContain("Please select a furniture product");
    expect(assistant.pendingIntent).toBeNull();
  });
});
