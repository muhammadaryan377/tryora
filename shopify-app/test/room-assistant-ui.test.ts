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
  let leadStatusGate: Promise<void> | null = null;
  const respond = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  const fetcher = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    calls.push({ method: init.method ?? "GET", url, body: init.body as FormData });
    if (url.startsWith("/apps/visully/lead/status?")) {
      if (leadStatusGate) await leadStatusGate;
      return respond({ satisfied: proxy.leadSatisfied });
    }
    if (url === "/apps/visully/lead/skip") { proxy.leadSatisfied = true; return respond({ ok: true }); }
    if (url.startsWith("/apps/visully/assistant/suggestions?")) return respond({ suggestions: proxy.suggestions, recommendation: proxy.recommendation });
    if (url === "/apps/visully/assistant/turn") { forms.push(init.body as FormData); return respond({ turnId: `turn${forms.length}` }); }
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
    if (url === "/apps/visully/preview") return respond(proxy.previewError ? { error: proxy.previewError } : { jobId: "job1" }, proxy.previewError ? 400 : 200);
    if (url.startsWith("/apps/visully/preview/job1")) return respond({ stage: "ready", image: "data:image/jpeg;base64,YQ==", token: "tok", expiresAt: Date.now() + 60_000 });
    if (url === "/apps/visully/ack") return respond({ ok: true });
    if (url.startsWith("/apps/visully/assistant/options?")) return proxy.options ? respond(proxy.options) : respond({ error: "NOT_FOUND" }, 404);
    if (url.startsWith("/apps/visully/assistant/preview-check?")) {
      // By default the server confirms what the options model offered; a test can return a precise refusal instead.
      const variantId = new URL(url, "https://shop.example").searchParams.get("variant");
      const variant = proxy.options?.variants.find((v: any) => v.id === variantId);
      // A test can hold the check open to reproduce a shopper changing options while it is pending.
      if (proxy.checkGate) await proxy.checkGate;
      const answer = typeof proxy.check === "function" ? proxy.check(variantId) : proxy.check;
      return respond(answer ?? { variantId, previewAvailable: true, previewStatus: "available", previewReason: null, optionValue: variant?.previewOption ?? null, referenceImage: null });
    }
    if (url === "/apps/visully/lead") {
      const email = String((init.body as FormData).get("email") ?? "");
      if (email.includes("@")) { proxy.leadSatisfied = true; return respond({ ok: true }); }
      return respond({ error: "BAD_EMAIL" }, 400);
    }
    if (url.startsWith("data:")) return new Response(new Blob(["a"], { type: "image/jpeg" }));
    throw new Error(`Unexpected request ${url}`);
  });
  const proxy = {
    leadSatisfied: false,
    suggestions: [] as string[],
    recommendation: null as any,
    fetcher, forms, calls, turns, previewError: "" as string, options: null as any, check: null as any, checkGate: null as Promise<void> | null,
    script(...batches: any[][]) { turns.push(batches); },
    hold() { let release!: () => void; pollGate = new Promise((resolve) => { release = resolve; }); return () => { pollGate = null; release(); }; },
    holdLeadStatus() { let release!: () => void; leadStatusGate = new Promise((resolve) => { release = resolve; }); return () => { leadStatusGate = null; release(); }; },
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
    // The Room Assistant deliberately follows the storefront palette, not the old merchant override.
    expect(button.style.getPropertyValue("--ta-accent")).toBe("#181818");
  });

  it("does not reserve space for an empty unmeasured chat widget", () => {
    const widget = document.createElement("div");
    widget.id = "shopify-chat";
    document.body.appendChild(widget);
    expect(buildAssistantLauncher(config, () => {}).classList.contains("tryora-assistant-launch--above-chat")).toBe(false);
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
    const assistant = makeAssistant({ productId: undefined, openCurrentPreview: undefined });
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
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("");
    expect($("[data-ta-attachment] img")!.getAttribute("src")).toBe("blob:room.jpg");
  });

  it("matches the approved two-card home design on product pages without exposing appearance selectors", () => {
    const assistant = makeAssistant({ productId: "1", productNoun: "bed" }, { greeting: "Hi, how can I help today?" });
    assistant.open();
    const welcome = $(".tryora-assistant__welcome")!;
    const actions = $$(".tryora-assistant__actions-grid [data-ta='welcome']");
    expect(actions).toHaveLength(2);
    expect(actions.map(action => action.dataset.action)).toEqual(["visualise", "recommend"]);
    expect(welcome.querySelector("h3")!.textContent).toBe("Hi, how can I help today?");
    expect(actions[0]!.querySelector("strong")!.textContent).toBe("Preview this product in my room");
    expect(actions[0]!.querySelector("small")!.textContent).toBe("Upload a photo of your room and see how this product looks in your space.");
    expect(actions[1]!.querySelector("strong")!.textContent).toBe("Find the perfect furniture for my room");
    expect(actions[1]!.querySelector("small")!.textContent).toBe("Get AI-powered furniture, style and colour recommendations for your space.");
    expect(welcome.querySelector("[data-ta='product-preview']")).not.toBeNull();
    expect(welcome.querySelectorAll("[data-ta='upload'], [data-ta='camera'], [data-ta='opt'], .tryora-assistant__swatch")).toHaveLength(0);
    expect($("textarea")!.getAttribute("placeholder")).toBe("Describe your room or ask for a preview…");
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
  });

  it("starts the visualise flow on a product page without showing a product preview handoff link", async () => {
    const assistant = makeAssistant();
    assistant.open();
    const pick = vi.spyOn($('[data-ta-file="upload"]') as HTMLInputElement, "click");
    click("[data-action='visualise']");
    expect(pick).not.toHaveBeenCalled();
    expect($(".tryora-assistant__photo-screen h3")!.textContent).toBe("Add a photo to preview this product");
    click("[data-ta='upload']");
    expect(pick).toHaveBeenCalled();
    proxy.script([{ type: "done" }]);
    await attachFile();
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("");
    proxy.script([{ type: "final", reply: { message: "Here is the card.", recommendations: [] } }, { type: "done" }]);
    click("[data-ta='send']");
    await settle(60);
    expect(JSON.parse(String(proxy.forms[0]!.get("selected")))).toEqual({ productRef: "1", variantRef: "11", source: "options" });
    assistant.newChat();
    expect($("[data-ta='product-preview']")).not.toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
    expect(assistant.isOpen).toBe(true);
  });
});

  it("both cards offer take-photo and upload-photo; recommendations never auto-charge", async () => {
    const assistant = makeAssistant(); assistant.open();
    for (const action of ["visualise", "recommend"]) {
      click(`[data-action='${action}']`);
      expect($(".tryora-assistant__photo-screen")).not.toBeNull();
      expect($$(".tryora-assistant__photo-actions button").map(b => b.dataset.ta)).toEqual(["camera", "upload"]);
      expect(proxy.forms).toHaveLength(0);
      click("[data-ta='photo-back']");
    }
    proxy.script([{ type: "done" }]);
    click("[data-action='recommend']");
    await attachFile();
    click("[data-ta='send']"); await settle(60);
    expect(proxy.forms).toHaveLength(1);
    expect(proxy.forms[0]!.get("photo")).toBeInstanceOf(Blob);
    const history = String(proxy.forms[0]!.get("history"));
    expect(history).toContain("Analyse my room photo");
    expect(history).toContain("suitable furniture from this store");
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
  });

describe("chat image upload", () => {
  it.each(["", "Find a compact blue sofa under GBP800"])("waits for Send and uses optional shopper text: %s", async (message) => {
    const assistant = makeAssistant(); assistant.open();
    click("[data-action='recommend']");
    await attachFile();
    expect(proxy.forms).toHaveLength(0);
    expect(assistant.state.entries).toHaveLength(0);
    expect($("[data-ta-attachment] img")).not.toBeNull();
    expect($("textarea")!.getAttribute("placeholder")).toContain("optional");
    if (message) await type(message);
    proxy.script([{ type: "room", room: { colours: ["white"], style: "modern", notes: "" } }, { type: "recommendations", items: [card()] }, { type: "done" }]);
    click("[data-ta='send']"); await settle(90);
    expect(proxy.forms).toHaveLength(1);
    const form = proxy.forms[0]!;
    expect(form.get("photo")).toBeInstanceOf(Blob);
    const history = JSON.parse(String(form.get("history")));
    if (message) expect(history.at(-1).content).toBe(message);
    else {
      expect(history.at(-1).content).toContain("Analyse my room photo");
      expect(history.at(-1).content).toContain("from this store");
    }
    expect($(".tryora-assistant__card")).not.toBeNull();
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
  });

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
    expect(assistant.attachment.url).toBe("blob:second.jpg");
    expect(assistant.roomPhoto).toBeNull();
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
    await type("Which bed would look best in this room?");
    const release = proxy.hold();
    await attachFile();
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
      { role: "assistant", content: expect.stringContaining("Option 1 suits your bright room.\nPreviously shown product cards (data):") },
      { role: "user", content: "What about grey?" },
    ]);
  });

  it("does not send stale room observations after the shopper uploads a different room", async () => {
    const assistant = makeAssistant();
    proxy.script(
      [{ type: "room", room: { colours: ["grey"], style: "first room", lighting: "dark", notes: "" } }],
      [{ type: "final", reply: { message: "First room analysed.", recommendations: [] } }, { type: "done" }],
    );
    proxy.script([{ type: "final", reply: { message: "Second room received.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Help with the first room");
    await attachFile("first.jpg");
    click("[data-ta='send']");
    await settle(90);
    expect(assistant.state.room).toMatchObject({ style: "first room" });

    await type("Now help with this different room");
    await attachFile("second.jpg");
    click("[data-ta='send']");
    await settle(90);
    expect(proxy.forms).toHaveLength(2);
    expect(proxy.forms[1]!.get("room")).toBeNull();
    expect(proxy.forms[1]!.get("photo")).toBeInstanceOf(Blob);
    expect(assistant.state.room).toBeNull();
  });

  it("does not retry an older failed photo request using a newer room photo", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "error", code: "PROVIDER_UNAVAILABLE" }]);
    proxy.script([{ type: "final", reply: { message: "New room noted.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Check the first room");
    await attachFile("first.jpg");
    click("[data-ta='send']");
    await settle(90);
    const failed = assistant.state.entries.find((entry: any) => entry.kind === "assistant" && entry.status === "error");
    expect(failed).toBeDefined();

    await type("Check my second room");
    await attachFile("second.jpg");
    click("[data-ta='send']");
    await settle(90);
    await assistant.retry(failed.id);
    expect(proxy.forms).toHaveLength(2);
    expect(document.body.textContent).toContain("The original room photo is no longer available");
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

  it("paces larger real model chunks while recommendation cards arrive without resetting the typing state", async () => {
    const assistant = makeAssistant();
    const answer = "The bright walls and warm wood floor give your room a calm foundation. ".repeat(15).trim();
    proxy.script(
      [{ type: "delta", text: answer }],
      [{ type: "recommendations", items: [card()] }],
      [{ type: "final", reply: { message: answer, recommendations: [] } }, { type: "done" }],
    );
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = proxy.fetcher.getMockImplementation()!;
    proxy.fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("&after=2")) await gate;
      return original(url, init);
    });
    assistant.open();
    await type("Which bed would suit this room?");
    click("[data-ta='send']");
    await settle(45);
    const first = $(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent!;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(answer.length);
    expect($(".tryora-assistant__card h4")!.textContent).toBe("Aria Bed");
    expect($(".tryora-assistant__bubble[aria-busy='true'] .tryora-assistant__text")).not.toBeNull();
    await settle(55);
    const progressed = $(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent!;
    expect(progressed.length).toBeGreaterThan(first.length);
    expect(progressed.length).toBeLessThanOrEqual(answer.length);
    release();
    await settle(60);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe(answer);
    expect($(".tryora-assistant__bubble[aria-busy='true']")).toBeNull();
    expect(assistant.typing.size).toBe(0);
  });

  it("clears an obsolete streamed draft on reset and never types stale content into the final reply", async () => {
    const assistant = makeAssistant();
    proxy.script(
      [{ type: "delta", text: "Unverified draft that must disappear. ".repeat(14) }],
      [{ type: "reset_text" }, { type: "delta", text: "Verified recommendation." }],
      [{ type: "final", reply: { message: "Verified recommendation.", recommendations: [] } }, { type: "done" }],
    );
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = proxy.fetcher.getMockImplementation()!;
    proxy.fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("&after=3")) await gate;
      return original(url, init);
    });
    assistant.open();
    await type("Help?");
    click("[data-ta='send']");
    await settle(65);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe("Verified recommendation.");
    expect(assistant.typing.size).toBeLessThanOrEqual(1);
    release();
    await settle(45);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe("Verified recommendation.");
    expect(assistant.typing.size).toBe(0);
  });

  it("does not queue a typing animation while minimised", async () => {
    const assistant = makeAssistant();
    const sentence = "These pieces complement your room without obscuring the existing furniture. ".repeat(10);
    proxy.script([{ type: "delta", text: sentence }], [{ type: "final", reply: { message: sentence, recommendations: [] } }, { type: "done" }]);
    assistant.open();
    const original = proxy.fetcher.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    proxy.fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("&after=1")) await gate;
      return original(url, init);
    });
    assistant.minimise();
    void assistant.send("Suggest a sofa");
    await settle(45);
    expect(assistant.typing.size).toBe(0);
    assistant.open();
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe(sentence.trim());
    release();
    await settle(60);
    expect(assistant.typing.size).toBe(0);
  });

  it("honours reduced-motion preference by showing incoming model deltas without delayed characters", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    const assistant = makeAssistant();
    const answer = "A real model-generated recommendation for your bright room. ".repeat(12).trim();
    proxy.script([{ type: "delta", text: answer }], [{ type: "final", reply: { message: answer, recommendations: [] } }, { type: "done" }]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = proxy.fetcher.getMockImplementation()!;
    proxy.fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("&after=1")) await gate;
      return original(url, init);
    });
    assistant.open();
    await type("Which furniture would fit?");
    click("[data-ta='send']");
    await settle(40);
    expect($(".tryora-assistant__message--assistant .tryora-assistant__text")!.textContent).toBe(answer);
    expect(assistant.typing.size).toBe(0);
    release();
    await settle(50);
    expect(assistant.typing.size).toBe(0);
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
    expect(cards.map(node => node.querySelector(".tryora-assistant__primary")!.textContent)).toEqual(["Preview in my room", "Preview in my room", "Preview in my room"]);
    expect(cards.map(node => (node.querySelector(".tryora-assistant__primary") as HTMLButtonElement).disabled)).toEqual([false, true, true]);
    expect(cards.every(node => [...node.querySelectorAll(".tryora-assistant__card-actions > *")].map(b => b.textContent).join("|") === "View details|Preview in my room")).toBe(true);
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
    const request = proxy.calls.find((c) => c.url === "/apps/visully/preview")!;
    expect(request.body!.get("photo")).toBeInstanceOf(Blob);
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
  });

  it("generates a verified preview inside the chat through the existing preview endpoints and acknowledges after display", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "visualise", item: card() }], [{ type: "final", reply: { message: "Confirm to preview.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Show it in my room");
    await attachFile(); click("[data-ta='send']");
    await settle(60);
    click(".tryora-assistant__visualise [data-ta='preview']");
    click("[data-ta='confirm-preview']");
    await settle(1500);
    expect(assistant.state.selected).toEqual({ productRef: "1", variantRef: "11", source: "card" });
    const start = proxy.calls.find((call) => call.url === "/apps/visully/preview")!;
    expect(start.body!.get("product")).toBe("gid://shopify/Product/1");
    expect(start.body!.get("variant")).toBe("gid://shopify/ProductVariant/11");
    expect(start.body!.get("option")).toBe("Cream");
    expect(start.body!.get("photo")).toBeInstanceOf(Blob);
    const image = $(".tryora-assistant__preview img")!;
    expect(image.getAttribute("src")).toBe("blob:preview");
    expect($(".tryora-assistant__preview a[download]")).not.toBeNull();
    const ack = proxy.calls.findIndex((call) => call.url === "/apps/visully/ack");
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
  const previewStarts = () => proxy.calls.filter((call) => call.url === "/apps/visully/preview");
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
    expect(previewStarts()).toHaveLength(0);
    expect($(".tryora-assistant__card [data-ta='preview']")!.textContent).toBe("Preview in my room");
    expect($("[data-ta='confirm-preview']")).not.toBeNull();
    click("[data-ta='confirm-preview']"); await settle(1500);
    expect(previewStarts()).toHaveLength(1);
    expect(previewStarts()[0]!.body!.get("leadDone")).toBe("1");
  });

  it("requires the merchant's email in chatbot before generation, then reuses the proof", async () => {
    await cardWithPhoto({ lead: { mode: "required", timing: "before", showOptIn: true, optInWording: "Email me offers." } });
    await attachFile();
    click(".tryora-assistant__card [data-ta='preview']");
    click("[data-ta='confirm-preview']");
    await settle(100);
    expect(previewStarts()).toHaveLength(0);
    expect($$(".tryora-assistant__lead")).toHaveLength(1);
    expect($(".tryora-assistant__lead [data-ta='lead-skip']")).toBeNull();
    const email = $(".tryora-assistant__lead input[name='ta-lead-email']") as HTMLInputElement;
    email.value = "shopper@example.com";
    email.dispatchEvent(new Event("input", { bubbles: true }));
    click("[data-ta='lead-submit']");
    await settle(1500);
    expect(proxy.calls.some(call => call.url === "/apps/visully/lead")).toBe(true);
    expect(previewStarts()).toHaveLength(1);
    expect(previewStarts()[0]!.body!.get("channel")).toBe("assistant");
    expect(previewStarts()[0]!.body!.get("leadDone")).toBe("1");
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    click(".tryora-assistant__card [data-ta='preview']");
    click("[data-ta='confirm-preview']");
    await settle(1500);
    expect(previewStarts()).toHaveLength(2);
    expect($$(".tryora-assistant__lead")).toHaveLength(0);
  });

  it("fails safely when an outdated server still requires email, without displaying a lead form", async () => {
    await cardWithPhoto();
    await attachFile();
    proxy.previewError = "LEAD_REQUIRED";
    click(".tryora-assistant__card [data-ta='preview']");
    click("[data-ta='confirm-preview']");
    await settle(80);
    expect(previewStarts()).toHaveLength(1);
    expect($$(".tryora-assistant__lead")).toHaveLength(0);
    expect(document.body.textContent).toContain("This store requires the email step before another preview");
    expect(proxy.calls.some((call) => call.url === "/apps/visully/lead")).toBe(false);
  });

  it("asks after the first chatbot preview and lets skippable leads decline", async () => {
    await cardWithPhoto({ lead: { mode: "skippable", timing: "after", showOptIn: true, optInWording: "" } });
    await attachFile();
    click(".tryora-assistant__card [data-ta='preview']");
    click("[data-ta='confirm-preview']");
    await settle(1500);
    expect(previewStarts()).toHaveLength(1);
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    expect($$(".tryora-assistant__lead")).toHaveLength(1);
    click("[data-ta='lead-skip']");
    await settle(70);
    expect(proxy.calls.some(c => c.url === "/apps/visully/lead/skip")).toBe(true);
    expect($$(".tryora-assistant__lead [data-ta='lead-submit']")).toHaveLength(0);
  });

  it("locks two different product previews while the lead-status check is pending", async () => {
    const assistant = makeAssistant({}, { lead: { mode: "skippable", timing: "after", showOptIn: false, optInWording: "" } });
    assistant.open();
    assistant.roomPhoto = photo();
    const release = proxy.holdLeadStatus();
    const first = assistant.startPreview(card());
    const second = assistant.startPreview(card({
      id: "2:22", productRef: "2", variantRef: "22",
      productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/22",
      title: "Another Bed", optionValue: "Grey",
    }));
    await settle(40);
    expect(proxy.calls.filter(c => c.url.startsWith("/apps/visully/lead/status?"))).toHaveLength(1);
    expect(previewStarts()).toHaveLength(0);
    release();
    await Promise.all([first, second]);
    expect(previewStarts()).toHaveLength(1);
    expect(previewStarts()[0]!.body!.get("product")).toBe("gid://shopify/Product/1");
  });

  it("does not start a paid preview after Forget room invalidates a pending lead check", async () => {
    const assistant = makeAssistant({}, { lead: { mode: "skippable", timing: "after", showOptIn: false, optInWording: "" } });
    assistant.open();
    assistant.roomPhoto = photo();
    const release = proxy.holdLeadStatus();
    const pending = assistant.startPreview(card());
    await settle(20);
    assistant.forgetRoom();
    release();
    await pending;
    expect(previewStarts()).toHaveLength(0);
  });

  it("never starts a second job while one is generating", async () => {
    await cardWithPhoto({ lead: { mode: "off", timing: "before", showOptIn: false, optInWording: "" } });
    await attachFile();
    click(".tryora-assistant__card [data-ta='preview']");
    (document.querySelector(".tryora-assistant__card [data-ta='preview']") as HTMLButtonElement | null)?.click();
    click("[data-ta='confirm-preview']");
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
    await type("Thoughts?");
    await attachFile();
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
    await type("Beds for this room?");
    await attachFile();
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

  it("restores the existing paid preview job after navigating without starting another generation", async () => {
    const now = Date.now();
    sessionStorage.setItem(sessionKey(SHOP), JSON.stringify({
      v: 2, shop: SHOP, createdAt: now, updatedAt: now, entries: [
        { id: "continued-1", kind: "preview", item: card(), status: "generating",
          stage: "generating", idempotencyKey: "continued-1", jobId: "job1", at: now },
      ],
      room: null, preferences: null, shown: [], explored: [], selected: null, constraints: null,
      ui: { open: false, view: "side" }, lead: { done: true }, previewsDelivered: 0,
    }));
    const assistant = makeAssistant();
    assistant.open();
    expect($(".tryora-assistant__preview.is-loading")!.textContent).toContain("Continue browsing");
    click(".tryora-assistant__preview.is-loading [data-ta='minimise']");
    expect(assistant.isOpen).toBe(false);
    expect(launcher.classList.contains("is-generating")).toBe(true);
    await settle(1550);
    expect(proxy.calls.filter(call => call.url === "/apps/visully/preview")).toHaveLength(0);
    expect(proxy.calls.filter(call => call.url.endsWith("/preview/job1")).length).toBeGreaterThan(0);
    assistant.open();
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    expect(assistant.state.entries.find((entry: any) => entry.id === "continued-1").status).toBe("ready");
    expect(assistant.state.previewsDelivered).toBe(1);
    expect(launcher.classList.contains("is-generating")).toBe(false);
    expect(proxy.calls.filter(call => call.url === "/apps/visully/ack")).toHaveLength(1);
    expect(sessionStorage.getItem(sessionKey(SHOP))!).not.toContain("base64");
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
  it("offers an options retry but never previews an unresolved product without verified Shopify data", async () => {
    makeAssistant({ productId: undefined, currentVariantId: () => null }).open();
    proxy.script([{ type: "recommendations", items: [card({ variantRef: null, variantId: null,
      previewAvailable: false, previewStatus: "choose_options", optionValue: null, hasOptions: true })] }], [{ type: "done" }]);
    await type("Show beds");
    click("[data-ta='send']");
    await settle(60);
    const item = $(".tryora-assistant__card")!;
    expect([...item.querySelectorAll(".tryora-assistant__card-actions > *")].map(e => e.textContent)).toEqual(["View details", "Preview in my room"]);
    expect((item.querySelector("[data-ta='preview']") as HTMLButtonElement).disabled).toBe(true);
    expect($(".tryora-assistant__options [data-ta='options']")!.textContent).toContain("Retry loading options");
    expect(proxy.calls.some(c => c.url.includes("/assistant/options?"))).toBe(true);
    expect(proxy.calls.some(c => c.url === "/apps/visully/preview")).toBe(false);
  });


  it("shows the exact selected colour on product cards without changing preview actions", async () => {
    await showCards([card({ options: { Colour: "Cream", Fabric: "Velvet", Size: "King" } })]);
    const summary = $(".tryora-assistant__selected-colour")!;
    expect(summary.textContent).toContain("Fabric: Velvet");
    expect(summary.textContent).toContain("Colour: Cream");
    expect(summary.textContent).not.toContain("King");
    expect($$(".tryora-assistant__card-actions > *").map((node) => node.textContent)).toEqual(["View details", "Preview in my room"]);
    // Without a real sample it must not invent a swatch colour.
    expect(summary.querySelector(".tryora-assistant__selected-colour-swatch")).toBeNull();
  });

  it("omits colour when none is selected and escapes colour names", async () => {
    await showCards([
      card({ options: { Size: "King" } }),
      card({ id: "2:22", productRef: "2", options: { Color: "<img src=x onerror=alert(1)>" } }),
    ]);
    expect($$(".tryora-assistant__selected-colour")).toHaveLength(1);
    expect($(".tryora-assistant__selected-colour")!.textContent).toContain("<img src=x onerror=alert(1)>");
    expect($(".tryora-assistant__selected-colour img")).toBeNull();
  });

  it("uses a real dependent fabric-colour sample and clears stale colour when fabric changes", async () => {
    const assistant = await showCards([card({ options: { Fabric: "Velvet", Colour: "Oat" } })]);
    const entry = assistant.state.entries.find((item: any) => item.kind === "assistant" && item.recommendations.length)!;
    const key = `${entry.id}:0`;
    const data = {
      attributes: [
        { name: "Fabric", kind: "fabric", values: [] },
        { name: "Colour", kind: "colour", values: [{ value: "Oat", colour: null, image: null,
          samples: { Velvet: { colour: "#ccbbaa", image: null } } }] },
      ],
    };
    const panel = { productId: "gid://shopify/Product/1", data, selections: { Fabric: "Velvet", Colour: "Oat" },
      loading: false, error: "" };
    assistant.cardOptions.set(key, panel);
    assistant.renderAll();
    expect($(".tryora-assistant__selected-colour-swatch")!.getAttribute("style")).toContain("#ccbbaa");
    expect($(".tryora-assistant__selected-colour")!.textContent).toContain("Colour: Oat");
    delete (panel.selections as Record<string, string>).Colour;
    assistant.renderAll();
    expect($(".tryora-assistant__selected-colour")).toBeNull();
  });

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
    expect(disabled.textContent).toBe("Preview in my room");
    expect(general!.querySelector(`#${CSS.escape(disabled.getAttribute("aria-describedby")!)}`)!.textContent).toBe("This exact option isn't approved for AI room preview.");
    expect(reference!.querySelector(".tryora-assistant__thumb-note")!.textContent).toBe("Preview reference");
    expect(reference!.querySelector("[data-ta='preview']")).not.toBeNull();
  });

  it("shows the approved reference on the preview card and never sends image URLs for generation", async () => {
    const assistant = makeAssistant();
    const item = card({ image: "https://cdn.shopify.com/variant.jpg", imageSource: "variant", referenceImage: "https://cdn.shopify.com/approved-reference.jpg" });
    proxy.script([{ type: "visualise", item }], [{ type: "final", reply: { message: "Confirm to preview.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Show it in my room");
    await attachFile();
    click("[data-ta='send']");
    await settle(60);
    const visual = $(".tryora-assistant__visualise")!;
    expect(visual.querySelector("img")!.getAttribute("src")).toBe("https://cdn.shopify.com/approved-reference.jpg");
    expect(visual.querySelector(".tryora-assistant__thumb-note")!.textContent).toBe("Preview reference");
    click(".tryora-assistant__visualise [data-ta='preview']");
    click("[data-ta='confirm-preview']");
    await settle(1500);
    const start = proxy.calls.find((call) => call.url === "/apps/visully/preview")!;
    // The server re-resolves the approved reference itself; the browser only names the exact product and variant.
    expect([...start.body!.keys()].sort()).toEqual(["channel", "key", "leadDone", "mappingRevision", "option", "photo", "product", "sourceVariant", "variant", "visitor"]);
    expect(JSON.stringify([...start.body!.entries()].filter(([, value]) => typeof value === "string"))).not.toContain("cdn.shopify.com");
  });
});

describe("simple chat cards and safe direct previews", () => {
  async function showCards(items: any[], context: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
    const assistant = makeAssistant(context, overrides);
    proxy.script([{ type: "recommendations", items }], [{ type: "final", reply: { message: "Here you go.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("beds?");
    click("[data-ta='send']");
    await settle(60);
    return assistant;
  }

  const selectableOptions = () => ({
    productRef: "1", productId: "gid://shopify/Product/1", title: "Aria Bed", url: "/products/aria",
    image: "https://cdn.shopify.com/aria.jpg", imageAlt: null, currencyCode: "GBP",
    singleVariant: false, preview: { offered: true, reason: null },
    attributes: [
      { name: "Fabric", kind: "fabric", values: ["Plush", "Teddy"].map(value => ({ value, colour: null, image: null })) },
      { name: "Colour", kind: "colour", values: [
        { value: "Cream", colour: "#e6dac8", image: null }, { value: "Black", colour: "#151515", image: null },
        { value: "Orange", colour: "#cc873e", image: null },
      ] },
      { name: "Size", kind: "size", values: [{ value: "King", colour: null, image: null }] },
    ],
    variants: [
      { ref: "11", id: "gid://shopify/ProductVariant/11", values: { Fabric: "Plush", Colour: "Cream", Size: "King" },
        options: { Fabric: "Plush", Colour: "Cream", Size: "King" }, price: "899.00", available: true,
        image: "https://cdn.shopify.com/aria-11.jpg", previewOption: "Cream" },
      { ref: "12", id: "gid://shopify/ProductVariant/12", values: { Fabric: "Plush", Colour: "Black", Size: "King" },
        options: { Fabric: "Plush", Colour: "Black", Size: "King" }, price: "919.00", available: true,
        image: "https://cdn.shopify.com/aria-12.jpg", previewOption: "Black" },
      { ref: "13", id: "gid://shopify/ProductVariant/13", values: { Fabric: "Teddy", Colour: "Orange", Size: "King" },
        options: { Fabric: "Teddy", Colour: "Orange", Size: "King" }, price: "939.00", available: true,
        image: "https://cdn.shopify.com/aria-13.jpg", previewOption: "Orange" },
    ],
  });

  it("shows real fabric chips and labelled colour swatches on a recommended product card", async () => {
    proxy.options = selectableOptions();
    await showCards([card({ hasOptions: true, variantCount: 3, options: { Fabric: "Plush", Colour: "Cream", Size: "King" } })]);
    await settle(45);
    const element = $(".tryora-assistant__card")!;
    expect(element.querySelector(".tryora-assistant__card-choices")).not.toBeNull();
    expect(element.querySelector("[data-ta='opt'][data-attr='Fabric'][data-value='Plush']")).not.toBeNull();
    expect(element.querySelector("[data-ta='opt'][data-attr='Fabric'][data-value='Teddy']")).not.toBeNull();
    expect(element.querySelector("[data-ta='opt'][data-attr='Colour'][data-value='Cream']")).not.toBeNull();
    expect(element.querySelector("[data-ta='opt'][data-attr='Colour'][data-value='Black']")).not.toBeNull();
    expect(element.querySelector("[data-ta='opt'][data-attr='Colour'][data-value='Orange']")).toBeNull();
    expect(element.querySelector(".tryora-assistant__swatch-name")?.textContent).not.toBeNull();
    expect(element.querySelector("[data-ta='opt'][data-attr='Size']")).toBeNull();
    expect(element.textContent).toContain("Fabric: Plush");
    expect(element.textContent).toContain("Colour: Cream");
    expect(element.querySelectorAll(".tryora-assistant__card-actions > *")).toHaveLength(2);
    expect(proxy.calls.some(call => call.url.startsWith("/apps/visully/assistant/options?"))).toBe(true);
  });

  it("switches dependent fabric and colour to the exact Shopify variant without silently previewing the old one", async () => {
    proxy.options = selectableOptions();
    const assistant = await showCards([card({ hasOptions: true, variantCount: 3, options: { Fabric: "Plush", Colour: "Cream", Size: "King" } })]);
    await settle(45);
    click("[data-ta='opt'][data-attr='Fabric'][data-value='Teddy']");
    const inProgress = $(".tryora-assistant__card")!;
    expect(inProgress.querySelector("[data-ta='opt'][data-attr='Colour'][data-value='Cream']")).toBeNull();
    expect(inProgress.querySelector("[data-ta='opt'][data-attr='Colour'][data-value='Orange']")).not.toBeNull();
    expect(inProgress.querySelector(".tryora-assistant__selected-colour")).toBeNull();
    expect(inProgress.querySelector(".tryora-assistant__price")).toBeNull();
    expect((inProgress.querySelector("[data-ta='preview']") as HTMLButtonElement).disabled).toBe(true);
    expect(assistant.state.selected).toEqual({ productRef: "1", variantRef: null, source: "options" });
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
    click("[data-ta='opt'][data-attr='Colour'][data-value='Orange']");
    await settle(60);
    const chosen = $(".tryora-assistant__card")!;
    expect(chosen.querySelector(".tryora-assistant__price")!.textContent).toMatch(/939\.00/);
    expect(chosen.querySelector(".tryora-assistant__thumb img")!.getAttribute("src")).toBe("https://cdn.shopify.com/aria-13.jpg");
    expect(chosen.querySelector("a[data-ta='view-details']")!.getAttribute("href")).toBe("/products/aria?variant=13");
    expect(chosen.textContent).toContain("Colour: Orange");
    expect(assistant.state.selected).toEqual({ productRef: "1", variantRef: "13", source: "options" });
    expect(proxy.calls.some(call => call.url.includes("/assistant/preview-check?") && call.url.includes("ProductVariant%2F13"))).toBe(true);
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
  });

  it("keeps Preview disabled for a selected colour rejected by the exact-variant check", async () => {
    proxy.options = selectableOptions();
    proxy.check = { variantId: "gid://shopify/ProductVariant/13", previewAvailable: false,
      previewStatus: "unavailable", previewReason: "The merchant hasn't approved this colour.", optionValue: null };
    await showCards([card({ hasOptions: true, variantCount: 3, options: { Fabric: "Plush", Colour: "Cream", Size: "King" } })]);
    await settle(45);
    click("[data-ta='opt'][data-attr='Fabric'][data-value='Teddy']");
    click("[data-ta='opt'][data-attr='Colour'][data-value='Orange']");
    await settle(60);
    expect(($(".tryora-assistant__card [data-ta='preview']") as HTMLButtonElement).disabled).toBe(true);
    expect($(".tryora-assistant__card")!.textContent).toContain("The merchant hasn't approved this colour.");
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
  });

  it("retries a failed card option request when Shopify data becomes available", async () => {
    await showCards([card({ hasOptions: true, variantCount: 3 })]);
    await settle(35);
    expect($(".tryora-assistant__options [data-ta='options']")).not.toBeNull();
    proxy.options = selectableOptions();
    click(".tryora-assistant__options [data-ta='options']");
    await settle(50);
    expect($(".tryora-assistant__card [data-ta='opt'][data-attr='Fabric'][data-value='Plush']")).not.toBeNull();
  });

  it("previews the exact clicked card rather than silently using a different product-page variant", async () => {
    const assistant = await showCards([card({ referenceImage: "https://cdn.shopify.com/approved.jpg", hasOptions: true, variantCount: 2 })],
      { currentVariantId: () => "12" });
    assistant.roomPhoto = photo();
    click(".tryora-assistant__card [data-ta='preview']");
    expect($("[data-ta='confirm-preview']")).not.toBeNull();
    expect(proxy.calls.some(c => c.url === "/apps/visully/preview")).toBe(false);
    click("[data-ta='confirm-preview']");
    await settle(1500);
    const start = proxy.calls.find(c => c.url === "/apps/visully/preview")!;
    expect(start.body!.get("variant")).toBe("gid://shopify/ProductVariant/11");
    expect(start.body!.get("option")).toBe("Cream");
    expect(proxy.calls.some(c => c.url.includes("/assistant/preview-check?"))).toBe(false);
    expect(assistant.state.selected).toEqual({ productRef: "1", variantRef: "11", source: "card" });
  });

  it("keeps preview disabled for unapproved products not selected on the current product page", async () => {
    await showCards([card({ productRef: "7", productId: "gid://shopify/Product/7", variantId: null, variantRef: null,
      previewAvailable: false, optionValue: null, previewStatus: "not_configured", hasOptions: true })]);
    expect(($(".tryora-assistant__card [data-ta='preview']") as HTMLButtonElement).disabled).toBe(true);
    expect(proxy.calls.some((c) => c.url === "/apps/visully/preview")).toBe(false);
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

  it("clears legacy email prompts restored from an older chat session", () => {
    const oldLead = { id: "old-lead", kind: "lead", status: "open", after: false, item: card(), at: Date.now() };
    sessionStorage.setItem(sessionKey(SHOP), JSON.stringify({ v: 2, shop: SHOP, createdAt: Date.now(), updatedAt: Date.now(),
      entries: [oldLead], room: null, preferences: null, shown: [], selected: null, ui: { open: false, view: "side" },
      lead: { done: false }, previewsDelivered: 0 }));
    const assistant = makeAssistant();
    assistant.open();
    expect($$(".tryora-assistant__lead")).toHaveLength(0);
    expect(assistant.state.entries.some((entry: any) => entry.kind === "lead")).toBe(false);
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
    expect(cards.map(card => [...card.querySelectorAll("button, a")].map(node => node.textContent).join("|"))).toEqual(["View details|Preview in my room", "View details|Preview in my room"]);
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
    expect((shown[0]!.querySelector("[data-ta='preview']") as HTMLButtonElement).disabled).toBe(true);
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
    expect($("[data-action='visualise']")!.textContent).toContain("Preview this product in my room");
    expect($("[data-action='recommend']")!.textContent).toContain("Find the perfect furniture for my room");
    expect($$(".tryora-assistant__welcome [data-ta='welcome']")).toHaveLength(2);
    expect($(".tryora-assistant__welcome [data-ta='upload']")).toBeNull();
    expect($("[data-ta='product-preview']")).not.toBeNull();
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
    const assistant = makeAssistant(); assistant.open(); assistant.welcomeAction("recommend");
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
    const assistant = makeAssistant({ preparePhoto: prepare }); assistant.open(); assistant.welcomeAction("recommend");
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
    await type("This is my room. What colour would suit it?");
    await attachFile(); click("[data-ta='send']");
    expect(assistant.pendingIntent).toBeNull();
    expect($(".tryora-assistant__menu--attach")!.hidden).toBe(true);
    await settle(60);
    expect(proxy.forms[0]!.get("photo")).toBeInstanceOf(Blob);
    expect(String(proxy.forms[0]!.get("history"))).toContain("What colour would suit it?");
    expect(proxy.calls.some((call) => call.url === "/apps/visully/preview")).toBe(false);
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
    expect($("[data-action='visualise']")!.textContent).toContain("Preview this product in my room");
    expect($("[data-action='recommend']")!.textContent).toContain("Find the perfect furniture for my room");
    click("[data-action='visualise']"); await settle(60);
    expect($(".tryora-assistant__photo-screen")).not.toBeNull();
    expect($$(".tryora-assistant__photo-actions button").map((b) => b.dataset.ta)).toEqual(["camera", "upload"]);
    expect(proxy.forms).toHaveLength(0);
    await attachFile(); await settle(60);
    expect(proxy.forms).toHaveLength(0);
    click("[data-ta='send']"); await settle(60);
    expect(proxy.forms).toHaveLength(1);
    expect(String(proxy.forms[0]!.get("history"))).toContain("furniture from this store that I can preview");
    expect(proxy.calls.some((call) => call.url === "/apps/visully/preview")).toBe(false);
  });
});


describe("catalogue welcome copy without question chips", () => {
  it("updates only verified recommendation copy without losing the composer draft or enabling a homepage preview", async () => {
    proxy.recommendation = { noun: "sofa", fabric: true, colour: false };
    const assistant = makeAssistant({ productId: undefined, productNoun: undefined, openCurrentPreview: undefined });
    assistant.open();
    await type("My room has an oak floor");
    await settle();
    expect($("[data-ta-recommend-title]")!.textContent).toBe("Find the perfect furniture for my room");
    expect($("[data-ta-recommend-description]")!.textContent).toBe("Get AI-powered furniture, style and colour recommendations for your space.");
    expect(($("textarea") as HTMLTextAreaElement).value).toBe("My room has an oak floor");
    expect($$("[data-ta='welcome']")).toHaveLength(2);
    expect($("[data-action='ask']")).toBeNull();
    expect($("[data-action='visualise']")!.textContent).toContain("Preview this product in my room");
    expect(proxy.forms).toHaveLength(0);
  });
  it("shows simple bed recommendation copy without requesting fabrics or colours", async () => {
    proxy.recommendation = { noun: "bed", fabric: true, colour: true };
    const assistant = makeAssistant({ productId: undefined, openCurrentPreview: undefined }); assistant.open(); await settle();
    expect($("[data-action='visualise']")!.textContent).toContain("Preview this product in my room");
    expect($("[data-ta-recommend-description]")!.textContent).toBe("Get AI-powered furniture, style and colour recommendations for your space.");
    expect($(".tryora-assistant__welcome")!.textContent).not.toMatch(/Choose a (fabric|colour|size)/i);
    expect($("[data-action='ask']")).toBeNull();
    expect($(".tryora-assistant__welcome")!.textContent).not.toContain("Ask about products");
  });
  it("ignores invalid welcome metadata and does not add unsupported appearance choices", async () => {
    proxy.recommendation = { noun: "<script>bed</script>", fabric: true, colour: true };
    const assistant = makeAssistant({ productId: undefined, productNoun: undefined, openCurrentPreview: undefined });
    assistant.open(); await settle();
    expect($("[data-ta-recommend-description]")!.textContent).toBe("Get AI-powered furniture, style and colour recommendations for your space.");
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
    const assistant = makeAssistant(); assistant.open();
    proxy.script([{ type: "visualise", item }], [{ type: "final", reply: { message: "Confirm this exact reference.", recommendations: [] } }, { type: "done" }]);
    await type("Show this in my room"); await attachFile(); click("[data-ta='send']"); await settle(60);
    click(".tryora-assistant__visualise [data-ta='preview']");
    click("[data-ta='confirm-preview']"); await settle(1500);
    const posted = proxy.calls.find((call) => call.url === "/apps/visully/preview")!.body!;
    expect(posted.get("mappingRevision")).toBe("reviewed-revision");
    expect(posted.get("sourceVariant")).toBe("gid://shopify/ProductVariant/11");
    expect(posted.get("variant")).toBe("gid://shopify/ProductVariant/11");
    expect($(".tryora-assistant__preview [download]")).not.toBeNull();
  });
  it("does not start a managed preview after its captured Shopify page configuration changes", async () => {
    const assistant = makeAssistant({ currentVariantId: () => "12" }); assistant.open();
    await assistant.startPreview(card({ previewContext: { mappingRevision: "r", sourceVariantId: "gid://shopify/ProductVariant/11", pageSourceVariantId: "gid://shopify/ProductVariant/11" } }));
    expect($(".tryora-assistant__notice")!.textContent).toContain("not ready for an AI room preview");
    expect(proxy.calls.some((call) => call.url === "/apps/visully/preview")).toBe(false);
  });
});

describe("chat card popup handoff", () => {
  it("opens the verified current-product popup from a stale disabled card, without generating", async () => {
    const launch = vi.fn();
    const assistant = makeAssistant({ openAssistantPreview: launch }); assistant.open();
    proxy.script([{ type: "recommendations", items: [card({ previewAvailable: false, previewStatus: "not_configured", optionValue: null })] }, { type: "done" }]);
    await type("Tell me about Aria"); click("[data-ta='send']"); await settle(90);
    const preview = $(".tryora-assistant__card [data-ta='preview']") as HTMLButtonElement;
    expect(preview.disabled).toBe(false);
    preview.click();
    expect(launch).toHaveBeenCalledOnce();
    expect(assistant.isOpen).toBe(false);
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
  });
  it("does not open the current product's popup for an unrelated unverified recommendation", async () => {
    const launch = vi.fn();
    const assistant = makeAssistant({ openAssistantPreview: launch }); assistant.open();
    proxy.script([{ type: "recommendations", items: [card({ id: "2:22", productRef: "2", productId: "gid://shopify/Product/2", variantRef: "22", variantId: "gid://shopify/ProductVariant/22", previewAvailable: false, previewStatus: "not_configured", optionValue: null })] }, { type: "done" }]);
    await type("Show another bed"); click("[data-ta='send']"); await settle(90);
    const preview = $(".tryora-assistant__card [data-ta='preview']") as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    preview.click(); expect(launch).not.toHaveBeenCalled();
  });
  it("keeps earlier recommendation batches beyond 24 products in the next request", async () => {
    const assistant = makeAssistant(); assistant.open();
    assistant.state.explored = Array.from({ length: 40 }, (_, i) => ({ productRef: String(i + 1), variantRef: null }));
    proxy.script([{ type: "done" }]);
    await type("Show me another bed"); click("[data-ta='send']"); await settle(90);
    const explored = JSON.parse(String(proxy.forms[0]!.get("explored")));
    expect(explored).toHaveLength(40);
    expect(explored[0].productRef).toBe("1");
  });
  const result = () => ({
    jobId: "popup-job", productId: "gid://shopify/Product/1", title: "Aria Bed", variantId: "gid://shopify/ProductVariant/11",
    optionValue: "Cream", selectionLabel: "Velvet / Cream", selectedOptions: { Fabric: "Velvet", Colour: "Cream", Size: "King" },
    image: new Blob(["image"], { type: "image/jpeg" }), room: new Blob(["room"], { type: "image/jpeg" }), leadDone: true,
  });
  it("opens the popup from the first card and delivers its generated result into chat", () => {
    const launch = vi.fn();
    const assistant = makeAssistant({ openAssistantPreview: launch });
    assistant.open(); click("[data-action='visualise']");
    expect(assistant.isOpen).toBe(false);
    expect(launch).toHaveBeenCalledOnce();
    expect($(".tryora-assistant__photo-screen")).toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
    const hooks = launch.mock.calls[0]![0];
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
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
    expect($("[data-ta='product-preview']")).not.toBeNull();
    expect(openPreview).not.toHaveBeenCalled(); // Legacy incoming results remain supported without an extra home action.
  });
  it.each([undefined, "1", "99"])("keeps two cards and photo-first recommendations with popup hooks on page %s", async (productId) => {
    const launch = vi.fn();
    const assistant = makeAssistant({ productId, openAssistantPreview: launch });
    assistant.open();
    expect($$(".tryora-assistant__actions-grid [data-ta='welcome']").map(el => el.dataset.action)).toEqual(["visualise", "recommend"]);
    for (const action of ["visualise", "recommend"]) {
      click(`[data-action='${action}']`);
      if (action === "visualise" && productId) {
        expect(launch).toHaveBeenCalledOnce();
        expect(assistant.isOpen).toBe(false);
        launch.mock.calls[0]![0].closed();
        expect(assistant.isOpen).toBe(true);
        continue;
      }
      expect($(".tryora-assistant__photo-screen")).not.toBeNull();
      expect($("[data-ta='upload']")).not.toBeNull();
      expect($("[data-ta='camera']")).not.toBeNull();
      click("[data-ta='photo-back']");
    }
    expect(launch).toHaveBeenCalledTimes(productId ? 1 : 0);
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
    expect(proxy.forms).toHaveLength(0);
  });

  it("opens the popup alternative and preserves state on cancel, then appends its result", () => {
    const launch = vi.fn();
    const assistant = makeAssistant({ openAssistantPreview: launch, openCurrentPreview: undefined });
    assistant.open();
    assistant.state.entries.push({ id: "history", kind: "user", text: "Keep my conversation", at: Date.now() });
    assistant.roomPhoto = photo("previous-room.jpg");
    assistant.attachment = photo("draft-room.jpg");
    assistant.state.room = { style: "previous room", colours: [] };
    assistant.previewUrls.set("previous-preview", "blob:previous-preview");
    assistant.originals.set("previous-preview", "blob:previous-room.jpg");
    const previousState = JSON.stringify(assistant.state.entries);
    const previousRoom = assistant.roomPhoto;
    const previousAttachment = assistant.attachment;
    click("[data-ta='product-preview']");
    const hooks = launch.mock.calls[0]![0];
    expect(assistant.isOpen).toBe(false);
    expect(openPreview).not.toHaveBeenCalled();
    expect(hooks.leadDone()).toBe(false);
    hooks.closed();
    expect(assistant.isOpen).toBe(true);
    expect(JSON.stringify(assistant.state.entries)).toBe(previousState);
    expect(assistant.roomPhoto).toBe(previousRoom);
    expect(assistant.attachment).toBe(previousAttachment);
    expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
    const photoEpoch = assistant.photoEpoch;
    expect(hooks.deliver(result())).toBe(true);
    expect(assistant.photoEpoch).toBeGreaterThan(photoEpoch);
    expect(assistant.state.entries[0].text).toBe("Keep my conversation");
    expect(assistant.previewUrls.get("previous-preview")).toBe("blob:previous-preview");
    expect(assistant.originals.get("previous-preview")).toBe("blob:previous-room.jpg");
    expect(assistant.roomPhoto.blob).toEqual(result().room);
    expect(assistant.attachment).toBeNull();
    expect(assistant.state.room).toBeNull();
    expect($(".tryora-assistant__preview img")).not.toBeNull();
    expect(hooks.leadDone()).toBe(true);
    expect(hooks.deliver(result())).toBe(true);
    expect(assistant.state.entries.filter((entry: any) => entry.kind === "preview")).toHaveLength(1);
    expect(assistant.state.previewsDelivered).toBe(1);
    assistant.newChat(); assistant.minimise();
    hooks.closed();
    expect(assistant.isOpen).toBe(false);
    expect(hooks.deliver({ ...result(), jobId: "late" })).toBe(false);
    expect(hooks.leadDone()).toBe(false);
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
  it("keeps the current product selected while its preview eligibility is unresolved", async () => {
    const assistant = makeAssistant({ productId: "99", productNoun: undefined, openCurrentPreview: undefined, openAssistantPreview: undefined });
    assistant.open();
    expect($("[data-action='visualise']")!.textContent).toContain("Preview this product in my room");
    const picker = vi.spyOn($("[data-ta-file='upload']")!, "click");
    click("[data-action='visualise']"); await settle();
    expect($(".tryora-assistant__photo-screen")).not.toBeNull();
    expect(assistant.state.selected.productRef).toBe("99");
    expect(picker).not.toHaveBeenCalled(); expect(openPreview).not.toHaveBeenCalled();
    expect(proxy.forms).toHaveLength(0);
    expect(assistant.isOpen).toBe(true);
    expect(proxy.calls.some(c => c.url === "/apps/visully/preview")).toBe(false);
  });
  it("does not open a supplied popup hook without a current product identity", async () => {
    const popup = vi.fn();
    const assistant = makeAssistant({ productId: undefined, openAssistantPreview: popup, openCurrentPreview: undefined });
    assistant.open(); click("[data-action='visualise']");
    expect(popup).not.toHaveBeenCalled();
    await settle(60);
    expect($(".tryora-assistant__photo-screen")).not.toBeNull();
    expect(proxy.forms).toHaveLength(0);
    await attachFile(); await settle(60);
    expect(proxy.forms).toHaveLength(0);
    click("[data-ta='send']"); await settle(60);
    expect(proxy.forms).toHaveLength(1);
    expect(String(proxy.forms[0]!.get("history"))).toContain("furniture from this store that I can preview");
    expect(assistant.pendingIntent).toBeNull();
  });
});


describe("guided preview results", () => {
  it("compares the correct original and previous previews and reuses the room without another upload", async () => {
    const assistant = makeAssistant(); assistant.open();
    assistant.roomPhoto = photo("original-room.jpg");
    URL.createObjectURL = vi.fn().mockReturnValueOnce("blob:cream-result").mockReturnValueOnce("blob:grey-result") as any;
    await assistant.startPreview(card());
    const first = assistant.state.entries.find((entry: any) => entry.kind === "preview");
    expect($("[data-ta='change-colour']")).toBeNull();
    expect($("[data-ta='try-product']")!.textContent).toBe("Try another product");
    click("[data-ta='compare'][data-source='original']");
    expect($(".tryora-assistant__preview img")!.getAttribute("src")).toBe("blob:original-room.jpg");
    click("[data-ta='compare'][data-source='preview']");
    expect($(".tryora-assistant__preview img")!.getAttribute("src")).toBe("blob:cream-result");
    await assistant.startPreview(card());
    const second = assistant.state.entries.filter((entry: any) => entry.kind === "preview")[1];
    click('[data-ta="compare"][data-id="'+second.id+'"][data-source="'+first.id+'"]');
    expect(document.querySelector('[data-entry="'+second.id+'"] .tryora-assistant__preview img')!.getAttribute("src")).toBe("blob:cream-result");
    expect(proxy.calls.filter(c => c.url === "/apps/visully/preview")).toHaveLength(2);
    expect(proxy.forms).toHaveLength(0);
    expect(assistant.roomPhoto.url).toBe("blob:original-room.jpg");
  });

  it("shows cancelled generation as retryable instead of leaving an endless progress indicator", async () => {
    const assistant = makeAssistant(); assistant.open(); assistant.roomPhoto = photo();
    const original = proxy.fetcher.getMockImplementation()!;
    proxy.fetcher.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/apps/visully/preview") return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      return original(url, init);
    });
    const pending = assistant.startPreview(card()); await settle();
    expect($("[data-ta='cancel-preview']")).not.toBeNull();
    click("[data-ta='cancel-preview']"); await pending;
    expect($(".tryora-assistant__preview.is-loading")).toBeNull();
    expect($(".tryora-assistant__failed")!.textContent).toContain("Preview cancelled");
    expect($(".tryora-assistant__failed [data-ta='preview']")!.textContent).toBe("Try again");
  });
});


it("keeps a verified conversational colour choice instead of replacing it with the page variant", async () => {
  const assistant = makeAssistant(); assistant.open(); assistant.roomPhoto = photo();
  const grey = card({ id: "1:12", variantRef: "12", variantId: "gid://shopify/ProductVariant/12", optionValue: "Grey", options: { Colour: "Grey", Size: "King" } });
  proxy.script([{ type: "selected", item: grey, source: "conversation" }, { type: "done" }]);
  await type("Show it in grey"); click("[data-ta='send']"); await settle(60);
  expect(proxy.calls.some(c => c.url === "/apps/visully/preview")).toBe(false);
  click(".tryora-assistant__card [data-ta='preview']");
  expect(proxy.calls.some(c => c.url === "/apps/visully/preview")).toBe(false);
  click("[data-ta='confirm-preview']"); await settle(1500);
  expect(proxy.calls.find(c => c.url === "/apps/visully/preview")!.body!.get("variant")).toBe("gid://shopify/ProductVariant/12");
});


it("remembers a selected product card in later show-more requests", async () => {
  const assistant = makeAssistant(); assistant.open();
  proxy.script([{ type: "selected", item: card(), source: "conversation" }, { type: "final", reply: { message: "Here is Aria.", recommendations: [] } }, { type: "done" }]);
  await type("Show me Aria"); click("[data-ta='send']"); await settle(90);
  expect(assistant.state.explored).toContainEqual({ productRef: "1", variantRef: "11" });
  proxy.script([{ type: "done" }]);
  await type("show me moes"); click("[data-ta='send']"); await settle(90);
  expect(JSON.parse(String(proxy.forms.at(-1)!.get("explored")))).toContainEqual({ productRef: "1", variantRef: "11" });
  expect(proxy.calls.some(call => call.url === "/apps/visully/preview")).toBe(false);
});


describe("storefront security regression: untrusted recommendation attributes", () => {
  it("shows an inert details label and missing thumbnail for unsafe model-provided URLs", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "recommendations", items: [
      card({ url: "javascript:alert(1)", image: "data:image/svg+xml,<svg onload=alert(1)>" }),
    ] }], [{ type: "final", reply: { message: "Here you go.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Show me a bed");
    click("[data-ta='send']");
    await settle(60);
    const node = $(".tryora-assistant__card")!;
    expect(node.querySelector(".tryora-assistant__card-actions a[href]")).toBeNull();
    expect(node.querySelector(".tryora-assistant__card-actions [aria-disabled='true']")?.textContent).toBe("View details");
    expect(node.querySelector(".tryora-assistant__thumb img")).toBeNull();
    expect(node.querySelector(".tryora-assistant__thumb.is-missing")).not.toBeNull();
  });

  it("preserves safe Shopify product links and https images", async () => {
    const assistant = makeAssistant();
    proxy.script([{ type: "recommendations", items: [
      card({ url: "/products/aria?variant=11", image: "https://cdn.shopify.com/aria.jpg" }),
    ] }], [{ type: "final", reply: { message: "Here you go.", recommendations: [] } }, { type: "done" }]);
    assistant.open();
    await type("Show me a bed");
    click("[data-ta='send']");
    await settle(60);
    expect($(".tryora-assistant__card-actions a[href]")?.getAttribute("href")).toBe("/products/aria?variant=11");
    expect($(".tryora-assistant__thumb img")?.getAttribute("src")).toBe("https://cdn.shopify.com/aria.jpg");
  });
});
