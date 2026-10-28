import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * This is a minimal fake-DOM test for launcher boot/placement, not HTML parsing.
 * The secure HTML renderer is exercised separately by storefront-html-guard.test.ts
 * and the room-assistant DOM integration tests. Its browser DOMParser and
 * replaceChildren APIs are intentionally not implemented by FakeElement here.
 */
vi.mock("../../packages/storefront/src/html-guard.js", () => ({
  setSafeHtml: (target: { innerHTML: string }, html: string) => { target.innerHTML = html; },
  replaceWithSafeHtml: (target: { outerHTML?: string }, html: string) => { target.outerHTML = html; },
}));

/** Just enough DOM for storefront boot: elements, classes, styles, placement and listeners. */
class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  after: FakeElement[] = [];
  innerHTML = "";
  type = "";
  offsetHeight: number;
  listeners: Record<string, ((event: any) => void)[]> = {};
  private vars: Record<string, string> = {};
  style: any;
  constructor(public tag = "div", offsetHeight = 0) {
    this.offsetHeight = offsetHeight;
    const vars = this.vars;
    this.style = { cssText: "", left: "", right: "", position: "", setProperty: (name: string, value: string) => { vars[name] = value; } };
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (...names: string[]) => { this.className = [...new Set([...list(), ...names])].join(" "); },
      remove: (...names: string[]) => { this.className = list().filter((name) => !names.includes(name)).join(" "); },
      contains: (name: string) => list().includes(name),
    };
  }
  cssVar(name: string) { return this.vars[name]; }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  insertAdjacentElement(_position: string, child: FakeElement) { this.after.push(child); return child; }
  addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ??= []).push(listener); }
  setAttribute() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

interface Page {
  productId?: string;
  pageType: string;
  preview?: Record<string, unknown> | "error";
  assistant?: Record<string, unknown> | "error" | null;
  picker?: boolean;
  media?: boolean;
  mobile?: boolean;
}

let page: { body: FakeElement; picker: FakeElement; media: FakeElement; fetches: string[] };

const launcher = (overrides: Record<string, unknown> = {}) => ({
  mode: "tryora", type: "floating", wording: "See it in your room", showIcon: false, background: "#111111", text: "#FFFFFF",
  radiusPx: 999, position: "bottom-right", offsetPx: { x: 16, y: 16 }, showOnMobile: true, showOnDesktop: true, ...overrides,
});
const previewConfig = (overrides: Record<string, unknown> = {}) => ({
  enabled: true, available: true, productId: "gid://shopify/Product/1", product: "Aria Bed", productImage: null, itemNoun: "bed",
  placement: "replace", setting: "indoor", optionName: null, swatches: [], style: { template: "gallery", accent: null, useThemeFont: false },
  launcher: launcher(), lead: { mode: "off", timing: "before", showOptIn: false, optInWording: "" }, offer: null, mock: false, ...overrides,
});
const assistantConfig = (position = "bottom-right") => ({
  enabled: true, configured: true, providerReady: true, greeting: "Hi", launcher: { label: "Room assistant", position, colour: "#6f7046" },
});

function setup(options: Page) {
  const root = new FakeElement();
  root.dataset = { pageType: options.pageType, ...(options.productId ? { productId: options.productId } : {}) };
  const body = new FakeElement("body");
  const picker = new FakeElement("variant-picker");
  const media = new FakeElement("div", 400);
  const fetches: string[] = [];
  vi.stubGlobal("document", {
    readyState: "loading",
    title: "Demo",
    body,
    documentElement: new FakeElement(),
    getElementById: (id: string) => id === "tryora-root" ? root : null,
    querySelector: (selector: string) => selector.includes("variant-picker") && options.picker ? picker : null,
    querySelectorAll: (selector: string) => selector === ".product__media-item" && options.media ? [media] : [],
    createElement: (tag: string) => new FakeElement(tag, 44),
    addEventListener: vi.fn(),
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: !!options.mobile }) });
  vi.stubGlobal("location", { hash: "", pathname: "/products/aria", search: "" });
  vi.stubGlobal("getComputedStyle", () => ({ position: "static", getPropertyValue: () => "" }));
  vi.stubGlobal("localStorage", { getItem: () => "00000000-0000-4000-8000-000000000001", setItem: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetches.push(url);
    const respond = (value: unknown) => value === "error" ? Promise.reject(new Error("offline")) : Promise.resolve(Response.json(value));
    if (url.startsWith("/apps/visully/assistant/config")) {
      return options.assistant === null ? Response.json({ error: "NOT_FOUND" }, { status: 404 }) : respond(options.assistant ?? { enabled: false });
    }
    if (url.startsWith("/apps/visully/config")) return respond(options.preview ?? { enabled: false });
    throw new Error(`Unexpected fetch ${url}`);
  }));
  page = { body, picker, media, fetches };
}

async function boot() {
  const { boot } = await import("../../packages/storefront/src/main");
  await boot();
}

const all = () => [...page.body.children, ...page.picker.after, ...page.media.children];
const previewLaunchers = () => all().filter((element) => element.classList.contains("tryora-launch"));
const assistantLaunchers = () => all().filter((element) => element.classList.contains("tryora-assistant-launch"));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("storefront boot with Room Assistant and previews both enabled", () => {
  it("shows both launchers on a preview-enabled product page and stacks them when they share a corner", async () => {
    setup({ pageType: "product", productId: "1", preview: previewConfig(), assistant: assistantConfig("bottom-right") });
    await boot();
    expect(previewLaunchers()).toHaveLength(1);
    expect(previewLaunchers()[0]!.classList.contains("tryora-launch--floating")).toBe(true);
    expect(assistantLaunchers()).toHaveLength(1);
    const assistant = assistantLaunchers()[0]!;
    expect(assistant.classList.contains("tryora-assistant-launch--stacked")).toBe(true);
    expect(assistant.cssVar("--ta-stack")).toBe("56px");
    expect((globalThis as any).window.Tryora.open).toBeTypeOf("function");
    expect((globalThis as any).window.TryoraAssistant.open).toBeTypeOf("function");
  });

  it("does not stack when the floating launchers are on opposite sides", async () => {
    setup({ pageType: "product", productId: "1", preview: previewConfig({ launcher: launcher({ position: "bottom-left" }) }), assistant: assistantConfig("bottom-right") });
    await boot();
    expect(previewLaunchers()[0]!.style.left).toBe("16px");
    expect(assistantLaunchers()[0]!.classList.contains("tryora-assistant-launch--stacked")).toBe(false);
  });

  it("keeps the merchant's inline launcher placement", async () => {
    setup({ pageType: "product", productId: "1", picker: true, preview: previewConfig({ launcher: launcher({ type: "inline" }) }), assistant: assistantConfig() });
    await boot();
    expect(page.picker.after.map((element) => element.className)).toEqual([expect.stringContaining("tryora-launch--inline")]);
    expect(assistantLaunchers()).toHaveLength(1);
    expect(assistantLaunchers()[0]!.classList.contains("tryora-assistant-launch--stacked")).toBe(false);
  });

  it("keeps the merchant's overlay launcher placement", async () => {
    setup({ pageType: "product", productId: "1", media: true, preview: previewConfig({ launcher: launcher({ type: "overlay" }) }), assistant: assistantConfig() });
    await boot();
    expect(page.media.children.map((element) => element.className)).toEqual([expect.stringContaining("tryora-launch--overlay")]);
    expect(page.media.style.position).toBe("relative");
    expect(assistantLaunchers()).toHaveLength(1);
  });

  it("respects the merchant's device visibility for the preview launcher only", async () => {
    setup({ pageType: "product", productId: "1", mobile: true, preview: previewConfig({ launcher: launcher({ showOnMobile: false }) }), assistant: assistantConfig() });
    await boot();
    expect(previewLaunchers()).toHaveLength(0);
    expect(assistantLaunchers()).toHaveLength(1);
    // A merchant's own #tryora links still work.
    expect((globalThis as any).window.Tryora.open).toBeTypeOf("function");
  });
});

describe("each feature initialises independently", () => {
  it("never shows the preview launcher for a product that is not enabled and ready", async () => {
    setup({ pageType: "product", productId: "1", preview: { enabled: false }, assistant: assistantConfig() });
    await boot();
    expect(previewLaunchers()).toHaveLength(0);
    expect((globalThis as any).window.Tryora).toBeUndefined();
    expect(assistantLaunchers()).toHaveLength(1);
  });

  it("runs the assistant on home and collection pages without a product request", async () => {
    for (const pageType of ["index", "collection"]) {
      vi.resetModules();
      setup({ pageType, assistant: assistantConfig() });
      await boot();
      expect(page.fetches.some((url) => url.startsWith("/apps/visully/config"))).toBe(false);
      expect(assistantLaunchers()).toHaveLength(1);
      expect(previewLaunchers()).toHaveLength(0);
    }
  });

  it("keeps the preview launcher when the assistant is disabled, missing or unreachable", async () => {
    for (const assistant of [{ enabled: false }, null, "error" as const]) {
      vi.resetModules();
      setup({ pageType: "product", productId: "1", preview: previewConfig(), assistant });
      await boot();
      expect(previewLaunchers()).toHaveLength(1);
      expect(assistantLaunchers()).toHaveLength(0);
    }
  });

  it("keeps the assistant when the preview config request fails", async () => {
    setup({ pageType: "product", productId: "1", preview: "error", assistant: assistantConfig() });
    await boot();
    expect(previewLaunchers()).toHaveLength(0);
    expect(assistantLaunchers()).toHaveLength(1);
  });
});
