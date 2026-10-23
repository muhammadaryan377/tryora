// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAssistantLauncher, RoomAssistant } from "../../packages/storefront/src/assistant";
import { IDLE_MS, sessionKey } from "../../packages/storefront/src/assistant/session";

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
    if (url.startsWith("data:")) return new Response(new Blob(["a"], { type: "image/jpeg" }));
    throw new Error(`Unexpected request ${url}`);
  });
  const proxy = {
    fetcher, forms, calls, turns, previewError: "" as string,
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

function makeAssistant(extra: Record<string, unknown> = {}) {
  launcher = buildAssistantLauncher(config, () => {});
  document.body.appendChild(launcher);
  return new RoomAssistant(config, {
    productId: "1", openCurrentPreview: openPreview, launcher, currentVariantId: () => "11",
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
  it("offers three working actions and suggestion chips", async () => {
    const assistant = makeAssistant();
    assistant.open();
    expect($$("[data-ta='welcome']").map((button) => button.dataset.action)).toEqual(["visualise", "recommend", "ask"]);
    const picker = $('[data-ta-file="upload"]') as HTMLInputElement;
    const pick = vi.spyOn(picker, "click");
    ($("textarea") as HTMLTextAreaElement).blur();
    click("[data-action='ask']");
    expect(document.activeElement).toBe($("textarea"));
    click("[data-action='recommend']");
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
    expect(pick).toHaveBeenCalled();
    expect($(".tryora-assistant__notice")!.textContent).toMatch(/room photo/);
    await attachFile();
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("Show this product in my room.");
    proxy.script([{ type: "final", reply: { message: "Here is the card.", recommendations: [] } }, { type: "done" }]);
    click("[data-ta='send']");
    await settle(60);
    expect(JSON.parse(String(proxy.forms[0]!.get("selected")))).toEqual({ productRef: "1", variantRef: "11" });
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
    expect(cards[1]!.querySelector("[data-ta='preview']")).toBeNull();
    expect(cards[2]!.querySelector("[data-ta='preview']")).toBeNull();
    expect(cards.map((node) => node.querySelector(".tryora-assistant__badge")!.textContent)).toEqual(["Available to buy", "Available to buy", "Currently sold out"]);
    expect(cards[1]!.textContent).toMatch(/AI room preview not available/);
    expect(cards[1]!.textContent).toMatch(/799\.00.*–.*899\.00/);
    expect(cards[1]!.querySelector("a")!.getAttribute("href")).toBe("/products/oslo");
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

  it("asks for a photo before previewing and hands off when the store requires an email first", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "recommendations", items: [card()] }], [{ type: "final", reply: { message: "Option 1.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("beds?");
    click("[data-ta='send']");
    await settle(60);
    const pick = vi.spyOn($('[data-ta-file="upload"]') as HTMLInputElement, "click");
    click(".tryora-assistant__card [data-ta='preview']");
    expect(pick).toHaveBeenCalled();
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/preview")).toBe(false);
    proxy.previewError = "LEAD_REQUIRED";
    await attachFile();
    await settle(60);
    expect($(".tryora-assistant__message--preview")!.textContent).toMatch(/asks for your email/);
    expect($(".tryora-assistant__message--preview a")!.getAttribute("href")).toBe("/products/aria?variant=11#tryora");
    expect(proxy.calls.some((call) => call.url === "/apps/tryora/ack")).toBe(false);
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
