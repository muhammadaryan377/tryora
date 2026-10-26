/**
 * Real-browser end-to-end test for Room Assistant 2.0. Skipped unless TRYORA_E2E=1.
 *
 *   TRYORA_E2E=1 [TRYORA_E2E_BROWSER=<chrome or edge path>] [TRYORA_E2E_SCREENSHOTS=<dir>] npx vitest run test/assistant-browser.e2e.test.ts
 *
 * A local HTTP server plays the Shopify storefront and app proxy: it serves a product page with the built theme
 * assets and routes /apps/tryora/* to the real turn handlers (turn buffer, long-poll, SSE, cancel), backed by a
 * fixture catalogue and a deterministic streaming model. It does not exercise Shopify's own proxy; that needs a
 * real store.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configs: [] as any[], copy: { assistant: { enabled: true, pages: { product: true, home: true } } } as any }));
vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => ({ copy: state.copy })) },
    productPreviewConfig: {
      findMany: vi.fn(async (args: any) => state.configs.filter((config) => config.shopId === args.where.shopId &&
        (!args.where.productId?.in || args.where.productId.in.includes(config.productId)))),
      // The exact-variant preview check reads the same saved configuration.
      findUnique: vi.fn(async (args: any) => state.configs.find((config) => config.shopId === args.where.shopId_productId.shopId && config.productId === args.where.shopId_productId.productId) ?? null),
      findFirst: vi.fn(async (args: any) => state.configs.find((config) => config.shopId === args.where.shopId && config.productId === args.where.productId && config.enabled && config.readiness === "ready") ?? null),
    },
    shop: { findUnique: vi.fn(async () => ({ autoEnableProducts: false })) },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));
// The product page's verified preview model for Aria (normally storefrontConfig against the database).
vi.mock("../app/storefront.server", () => ({
  storefrontConfig: vi.fn(async (_admin: unknown, _shop: string, productId: string) => {
    if (productId !== "gid://shopify/Product/1") return { enabled: false };
    const variants = (globalThis as any).__ariaVariants as { id: string; selectedOptions: { name: string; value: string }[]; availableForSale: boolean }[];
    return {
      enabled: true, available: true, providerId: "shopify_native", singleVariants: [],
      lead: { mode: "required", timing: "before", showOptIn: true, optInWording: "Email me offers and updates from Demo Furniture." },
      swatches: ["Cream", "Grey"].map((colour) => ({
        value: colour, label: colour, group: null, colour: colour === "Cream" ? "#efe6d2" : "#8d8d8d", image: null, available: true,
        variants: variants.filter((variant) => variant.availableForSale && variant.selectedOptions.some((option) => option.value === colour)).map((variant) => ({ id: variant.id, image: null, options: {} })),
      })),
    };
  }),
}));

import { loadCatalogueWelcome } from "../app/assistant/suggestions.server";
import { cancelAssistantTurn, readAssistantTurn, startAssistantTurn, streamAssistantTurn } from "../app/assistant/turn-routes.server";
import { setAssistantClientForTests } from "../app/room-assistant.server";
import { checkVariantPreview, productOptionsForAssistant } from "../app/assistant/options.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { fixtureAdmin, fixtureProduct, furnitureCatalogue, finalAnswer, toolCall } from "./fixtures/assistant-store";

const RUN = process.env.TRYORA_E2E === "1";
const SHOP = "demo.myshopify.com";
const ASSETS = join(__dirname, "..", "extensions", "tryora-theme", "assets");
const SHOTS = process.env.TRYORA_E2E_SCREENSHOTS ?? "";
const BROWSERS = [
  process.env.TRYORA_E2E_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => !!path && existsSync(path));

setAssistantLogSink((line) => { if (process.env.TRYORA_E2E_DEBUG) console.error(line); });

// ---------- fixture store ----------

const aria = fixtureProduct({ id: 1, title: "Aria Upholstered Bed", productType: "Bed", options: { Colour: ["Cream", "Grey"], Size: ["King"] }, price: 899, tags: ["modern", "upholstered"] });
const products = [aria, ...furnitureCatalogue(40)];
for (const product of products) {
  // Realistic Shopify CDN URLs; the browser context serves them locally (see routeImages).
  product.featuredMedia = { preview: { image: { url: `https://cdn.shopify.com/s/files/e2e/${product.handle}.jpg`, altText: product.title } } };
  product.variants.forEach((variant, index) => { variant.image = { url: `https://cdn.shopify.com/s/files/e2e/${product.handle}-${index}.jpg` }; });
}
state.configs = [{
  id: "c1", shopId: SHOP, productId: aria.id, enabled: true, autoConfigured: false, visualOptionName: "Colour", itemNoun: "bed",
  placement: "replace", setting: "indoor", frozenContext: { Size: "King" }, readiness: "ready", readinessReasons: [],
  referenceMediaId: null, referenceAngle: "front", choices: [], updatedAt: new Date(),
}];
const admin = fixtureAdmin(products);
(globalThis as any).__ariaVariants = aria.variants;

/** A deterministic model: room notes → search → cards (or a preview offer) → a slowly streamed answer. */
const GAP_MS = 250;
const model = {
  responses: {
    create: async (body: any) => {
      const input: any[] = body.input;
      const lastUser = input.map((item, index) => ({ item, index })).filter(({ item }) => item.role === "user").at(-1)!;
      const outputs = input.slice(lastUser.index + 1).filter((item) => item.type === "function_call_output");
      const calls = input.slice(lastUser.index + 1).filter((item) => item.type === "function_call").map((item) => item.name);
      const text = (Array.isArray(lastUser.item.content) ? lastUser.item.content[0].text : lastUser.item.content) as string;
      const photo = Array.isArray(lastUser.item.content) && lastUser.item.content.some((part: any) => part.type === "input_image");
      const developer = String(input.find((item) => item.role === "developer")?.content ?? "");
      if (photo && !calls.includes("record_room_observations")) {
        return toolCall("record_room_observations", { colours: ["warm white", "light oak"], walls: "white", floor: "oak", style: "Scandinavian", lighting: "bright daylight", furniture: ["rug"], layout: "bed wall opposite the window", placement: ["centred on the back wall"], notes: "" });
      }
      // QA scenario A: the real model answered "select one" with option 1, whatever card the shopper had chosen.
      if (/^select one$/i.test(text.trim())) {
        const results = outputs.map((item) => JSON.parse(item.output));
        const mismatch = results.find((output) => output.error === "reference_mismatch");
        if (!calls.includes("select_product")) return toolCall("select_product", { productRef: developer.match(/1\. productRef (\d+)/)![1], variantRef: null });
        if (mismatch && calls.filter((name) => name === "select_product").length === 1) {
          return toolCall("select_product", { productRef: mismatch.expectedProductRef, variantRef: null }, "call-select-corrected");
        }
        return finalAnswer("That one is selected.");
      }
      if (/in my room/i.test(text) && !calls.includes("request_visualisation")) {
        if (/aria/i.test(text)) {
          const cream = aria.variants.find((variant) => variant.selectedOptions[0]!.value === "Cream")!;
          return toolCall("request_visualisation", { productRef: "1", variantRef: cream.id.split("/").pop() });
        }
        const selected = developer.match(/selected most recently: productRef (\d+), variantRef (\d+)/) ?? developer.match(/1\. productRef (\d+), variantRef (\d+)/);
        if (selected) return toolCall("request_visualisation", { productRef: selected[1], variantRef: selected[2] });
      }
      if (!calls.includes("search_products") && !calls.includes("request_visualisation")) {
        return toolCall("search_products", { query: /bed/i.test(text) || photo ? "bed" : text, colour: /cream/i.test(text) ? "cream" : /grey/i.test(text) ? "grey" : null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: true, limit: 4 });
      }
      if (calls.includes("search_products") && !calls.includes("recommend_products")) {
        const found = JSON.parse(outputs.find((item, index) => calls[index] === "search_products")?.output ?? outputs.at(-1).output);
        const items = (found.results ?? []).slice(0, /three/i.test(text) ? 3 : 2).map((result: any) => ({ productRef: result.productRef, variantRef: result.matchingVariants[0]?.variantRef ?? null, reason: `The ${result.title} brings a colour and shape that suit the room.` }));
        if (items.length) return toolCall("recommend_products", { items });
      }
      const words = ["Here are ", /three/i.test(text) ? "three verified " : "two verified ", "options from ", "the store. ", "Option 1 suits ", "a bright, calm room."];
      return {
        async *[Symbol.asyncIterator]() {
          for (const word of words) {
            await new Promise((resolve) => setTimeout(resolve, GAP_MS));
            yield { type: "response.output_text.delta", delta: word };
          }
          yield { type: "response.completed", response: finalAnswer(words.join("")) };
        },
      };
    },
  },
} as any;

// ---------- harness server ----------

const seen = { turnsWithPhoto: 0, previewStarts: [] as Record<string, string>[], acks: 0, leads: [] as Record<string, string>[] };
let previewImage: Buffer;

function page(transport: "poll" | "sse") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aria Upholstered Bed – Demo Furniture</title><link rel="stylesheet" href="/assets/tryora.css">
  <style>body{margin:0;font-family:Georgia,serif}main{max-width:1100px;margin:0 auto;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:32px}
  .product__media-item{height:520px;background:#e9e4da}@media(max-width:749px){main{grid-template-columns:1fr}}</style></head>
  <body data-transport="${transport}"><main><div class="product__media-item"></div><div><h1>Aria Upholstered Bed</h1><p>£899.00</p>
  <form action="/cart/add"><input type="hidden" name="id" value="${aria.variants[0]!.id.split("/").pop()}"><button type="button">Add to cart</button></form>
  <p style="height:1400px">Long product description…</p></div></main>
  <div id="tryora-root" hidden data-page-type="product" data-product-id="1" data-product-handle="${aria.handle}"
    data-option-names='["Colour","Size"]' data-variant-options='["Cream","King"]'></div>
  <script src="/assets/tryora.js" defer></script></body></html>`;
}

async function webRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as any, body: chunks.length ? Buffer.concat(chunks) : undefined });
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value)); // real chunked transfer: each event is flushed as it is produced
  }
  res.end();
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function route(req: IncomingMessage): Promise<Response> {
  const url = new URL(`http://localhost${req.url}`);
  const path = url.pathname;
  if (path === "/" || path === "/sse") return new Response(page(path === "/sse" ? "sse" : "poll"), { headers: { "Content-Type": "text/html" } });
  if (path.startsWith("/products/")) return new Response(page("poll"), { headers: { "Content-Type": "text/html" } });
  if (path.startsWith("/assets/")) {
    const file = path.slice("/assets/".length);
    return new Response(readFileSync(join(ASSETS, file)), { headers: { "Content-Type": file.endsWith(".css") ? "text/css" : "text/javascript" } });
  }
  if (path.startsWith("/img/")) return new Response(new Uint8Array(previewImage), { headers: { "Content-Type": "image/jpeg" } });
  if (path === "/apps/tryora/config") {
    return json({
      enabled: true, available: true, productId: aria.id, product: aria.title, productImage: null, itemNoun: "bed", placement: "replace", setting: "indoor",
      productVariants: aria.variants.map((v) => ({ id: v.id, image: v.image?.url ?? null, options: Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])) })),
      singleVariants: aria.variants.filter((v) => v.availableForSale).map((v) => ({ id: v.id, image: v.image?.url ?? null, options: Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])) })),
      selectionOptionNames: [],
      optionName: null, swatches: [], style: { template: "gallery", accent: null, useThemeFont: false }, lead: { mode: "off", timing: "before", showOptIn: false, optInWording: "" },
      offer: null, mock: true,
      launcher: { mode: "tryora", type: "floating", wording: "See it in your room", showIcon: true, background: "#111111", text: "#FFFFFF", radiusPx: 999, position: "bottom-right", offsetPx: { x: 20, y: 20 }, showOnMobile: true, showOnDesktop: true },
    });
  }
  if (path === "/apps/tryora/assistant/config") {
    const transport = (req.headers.referer ?? "").includes("/sse") ? "sse" : "poll";
    const lead = (req.headers.referer ?? "").includes("lead=1")
      ? { lead: { mode: "required", timing: "before", showOptIn: true, optInWording: "Email me offers and updates from Demo Furniture." }, previewsAvailable: true } : {};
    return json({ enabled: true, configured: true, providerReady: true, greeting: "Hi, how can I help today?", shop: SHOP, defaultView: "side", transport, ...lead, launcher: { label: "Room Assistant", position: "bottom-right", colour: "#6f7046" } });
  }
  if (path === "/apps/tryora/assistant/suggestions") {
    return json(await loadCatalogueWelcome(admin, SHOP, url.searchParams.get("product") ?? undefined));
  }
  if (path === "/apps/tryora/check") return json({ ok: true, detected: "empty_space" });
  const request = await webRequest(req);
  try {
    if (path === "/apps/tryora/assistant/turn") {
      const form = await request.formData();
      if (form.get("photo")) seen.turnsWithPhoto += 1;
      return json(await startAssistantTurn(admin, SHOP, form));
    }
    if (path === "/apps/tryora/assistant/stream") return await streamAssistantTurn(admin, SHOP, await request.formData());
    const cancel = path.match(/^\/apps\/tryora\/assistant\/turn\/([\w-]+)\/cancel$/);
    if (cancel) return json(await cancelAssistantTurn(SHOP, String((await request.formData()).get("visitor")), cancel[1]!));
    const poll = path.match(/^\/apps\/tryora\/assistant\/turn\/([\w-]+)$/);
    if (poll) return json(await readAssistantTurn(SHOP, url.searchParams.get("visitor") ?? "", poll[1]!, Number(url.searchParams.get("after") ?? 0)));
    if (path === "/apps/tryora/preview") {
      const form = await request.formData();
      seen.previewStarts.push(Object.fromEntries([...form.entries()].map(([key, value]) => [key, typeof value === "string" ? value : `blob:${(value as Blob).size}`])));
      return json({ jobId: "job1" });
    }
    if (path === "/apps/tryora/preview/job1") return json({ stage: "ready", image: `data:image/jpeg;base64,${previewImage.toString("base64")}`, token: "tok", expiresAt: Date.now() + 60_000 });
    if (path === "/apps/tryora/ack") { seen.acks += 1; return json({ ok: true }); }
    if (path === "/apps/tryora/lead") {
      const form = await request.formData();
      const fields = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email ?? "")) return json({ error: "BAD_EMAIL" }, 400);
      seen.leads.push(fields);
      return json({ ok: true });
    }
    if (path === "/apps/tryora/assistant/options") return json(await productOptionsForAssistant(admin, SHOP, url.searchParams.get("product") ?? ""));
    if (path === "/apps/tryora/assistant/preview-check") return json(await checkVariantPreview(admin, SHOP, url.searchParams.get("product") ?? "", url.searchParams.get("variant") ?? "", url.searchParams.get("sourceVariant") || undefined));
  } catch (error: any) {
    if (process.env.TRYORA_E2E_DEBUG) console.error("harness", path, error);
    return json({ error: error?.code ?? "UNEXPECTED" }, 400);
  }
  return json({ error: "NOT_FOUND" }, 404);
}

// ---------- browser ----------

let server: Server;
let origin = "";
let browser: any;

/** Serves Shopify CDN image URLs from the harness so the browser loads real JPEG thumbnails offline. */
const routeImages = (context: any) => context.route("https://cdn.shopify.com/**", (route: any) => route.fulfill({ status: 200, contentType: "image/jpeg", body: previewImage }));

/** Waits for the drawer's open transition, so measurements reflect the final layout. */
const settled = (page: any) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

async function shot(page: any, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settled(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

describe.skipIf(!RUN)("Room Assistant 2.0 in a real browser", () => {
  beforeEach(() => {
    // Each journey owns its counters; new popup journeys must not inflate another test's delivery count.
    seen.turnsWithPhoto = 0;
    seen.previewStarts.length = 0;
    seen.acks = 0;
    seen.leads.length = 0;
  });

  beforeAll(async () => {
    if (!BROWSERS.length) throw new Error("No Chrome or Edge found; set TRYORA_E2E_BROWSER");
    process.env.OPENAI_API_KEY = "e2e-not-a-real-key";
    process.env.OPENAI_ASSISTANT_PRIVACY_ACKNOWLEDGED = "true";
    previewImage = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#cdbfa8" } }).jpeg().toBuffer();
    setAssistantClientForTests(() => model);
    server = createServer((req, res) => { void route(req).then((response) => send(res, response)).catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: BROWSERS[0], headless: true });
  }, 60_000);

  afterAll(async () => {
    setAssistantClientForTests(null);
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });


  it.each([1280, 390])("approved photo screens and composer sheet at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await routeImages(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    try {
      await page.goto(origin);
      await page.locator(".tryora-assistant-launch").click();
      await page.locator(".tryora-assistant__welcome").waitFor();
      expect(await page.locator("[data-action='visualise']").textContent()).toContain("Preview this bed in my room");
      expect(await page.locator(".tryora-assistant__actions-grid [data-ta='upload']").count()).toBe(0);
      expect(await page.locator("[data-ta-scroll]").evaluate((element: HTMLElement) => element.scrollTop)).toBe(0);
      await expect.poll(() => page.locator("[data-ta-recommend-description]").textContent()).toBe("Find the best bed and colour for your room.");
      expect(await page.locator(".tryora-assistant__suggestion, [data-ta-suggestions]").count()).toBe(0);
      expect(await page.locator("[data-ta='welcome']").count()).toBe(2);
      expect(await page.locator("[data-action='ask']").count()).toBe(0);
      expect(await page.locator("[data-action='visualise'] small").textContent()).toBe("See how this bed looks in your own space.");
      expect(await page.locator("[data-ta-recommend-description]").textContent()).toBe("Find the best bed and colour for your room.");
      await shot(page, `approved-${width}-welcome`);
      await page.locator("[data-action='visualise']").click();
      await page.locator(".tryora__dialog").waitFor();
      expect(await page.locator(".tryora-assistant__panel").isVisible()).toBe(false);
      await shot(page, `approved-${width}-preview-popup`);
      await page.locator(".tryora__dialog [data-act=close]").click();
      await page.locator(".tryora-assistant__welcome").waitFor();
      await page.locator("[data-action='recommend']").click();
      expect(await page.locator(".tryora-assistant__photo-screen h3").textContent()).toBe("Add a photo of your room");
      await shot(page, `approved-${width}-recommend-photo`);
      if (width === 390) {
        const chooserPromise = page.waitForEvent("filechooser");
        await page.locator("[data-ta='camera']").click();
        const chooser = await chooserPromise;
        expect(await chooser.element().getAttribute("capture")).toBe("environment");
        expect(await page.locator("[data-ta-attachment] img").count()).toBe(0);
      } else {
        await page.locator("[data-ta='camera']").click();
        expect(await page.locator(".tryora-assistant__camera-notice").textContent()).toContain("Choose Upload photo");
      }
      const layout = await page.locator(".tryora-assistant__photo-frame").evaluate((element: HTMLElement) => ({
        fits: element.scrollWidth <= element.clientWidth,
        choices: [...element.querySelectorAll("button")].map((button) => { const b = button.getBoundingClientRect(); return { x: b.x, right: b.right, y: b.y, height: b.height }; }),
      }));
      expect(layout.fits).toBe(true);
      expect(layout.choices[0].right).toBeLessThanOrEqual(layout.choices[1].x);
      await page.locator("[data-ta='photo-back']").click();
      await page.locator("[data-ta='attach']").click();
      expect(await page.locator(".tryora-assistant__menu--attach h3").textContent()).toBe("Add a photo to your message");
      await shot(page, `approved-${width}-composer-sheet`);
      await page.locator("[data-ta='photo-sheet-close']").focus();
      await page.keyboard.press("Escape");
      expect(await page.locator(".tryora-assistant__menu--attach").isVisible()).toBe(false);
      expect(await page.locator("[data-ta='attach']").evaluate((element: HTMLElement) => document.activeElement === element)).toBe(true);
      const previewsBefore = seen.previewStarts.length;
      await page.locator("[data-ta='attach']").click();
      await page.locator("[data-ta-file='upload']").setInputFiles({ name: "room.jpg", mimeType: "image/jpeg", buffer: previewImage });
      await page.locator("[data-ta-attachment] img").waitFor();
      expect(await page.locator(".tryora-assistant__menu--attach").isVisible()).toBe(false);
      expect(seen.previewStarts).toHaveLength(previewsBefore);
      await page.fill("textarea", "This is my room. What colour would suit it?");
      await shot(page, `approved-${width}-photo-draft`);
      expect(await page.locator("form[action='/cart/add'] [name='id']").inputValue()).toBe(aria.variants[0]!.id.split("/").pop());
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);



  it.each(["home", "unsupported-product"])("asks for furniture selection on %s without opening the preview popup", async (kind) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pageTab = await context.newPage();
    try {
      if (kind === "home") {
        await pageTab.route("**/without-product", (route: any) => route.fulfill({
          contentType: "text/html",
          body: page("poll").replace('data-page-type="product" data-product-id="1"', 'data-page-type="index"'),
        }));
      } else {
        await pageTab.route("**/apps/tryora/config?*", (route: any) => route.fulfill({ json: { enabled: false } }));
      }
      const modelRequests: string[] = [];
      pageTab.on("request", (request: any) => {
        if (new URL(request.url()).pathname === "/apps/tryora/assistant/turn") modelRequests.push(request.url());
      });
      await pageTab.goto(kind === "home" ? `${origin}/without-product` : origin);
      await pageTab.locator(".tryora-assistant-launch").click();
      expect(await pageTab.locator("[data-action=visualise]").textContent()).toContain("Select furniture to preview");
      await pageTab.locator("[data-action=visualise]").click();
      await pageTab.locator(".tryora-assistant__notice").waitFor();
      expect(await pageTab.locator(".tryora-assistant__notice").textContent()).toContain("Please select a furniture product");
      expect(await pageTab.locator(".tryora__dialog").count()).toBe(0);
      expect(await pageTab.locator(".tryora-assistant__photo-screen").count()).toBe(0);
      expect(await pageTab.locator("textarea").isVisible()).toBe(true);
      expect(seen.previewStarts).toHaveLength(0);
      expect(modelRequests).toEqual([]);
      await shot(pageTab, `guard-${kind}`);
      // Choosing furniture is still possible on a non-preview page, with no automatic generation.
      await pageTab.fill("textarea", "Which beds would suit my room?");
      await pageTab.locator("[data-ta='send']").click();
      await pageTab.locator(".tryora-assistant__card").first().waitFor({ timeout: 15_000 });
      const titles = await pageTab.locator(".tryora-assistant__card h4").allTextContents();
      expect(titles.length).toBeGreaterThan(0);
      expect(titles.every((title: string) => products.some((p) => p.title === title))).toBe(true);
      expect(seen.previewStarts).toHaveLength(0);
    } finally { await context.close(); }
  }, 30_000);

  it.each([1280, 390])("first welcome card opens the popup and delivers into chat at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await routeImages(context);
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.locator(".tryora-assistant-launch").click();
      expect(await page.locator(".tryora-assistant__actions-grid [data-ta=welcome]").count()).toBe(2);
      const before = seen.previewStarts.length, acksBefore = seen.acks;
      await page.locator("[data-action=recommend]").click();
      await page.locator(".tryora-assistant__photo-screen").waitFor();
      expect(await page.locator(".tryora__dialog").count()).toBe(0);
      await page.locator("[data-ta=photo-back]").click();
      await page.locator("[data-action=visualise]").click();
      await page.locator(".tryora__dialog").waitFor();
      expect(await page.locator(".tryora-assistant__panel").isVisible()).toBe(false);
      expect(seen.previewStarts).toHaveLength(before);
      // Cancelling only reopens the conversation; it does not start a job.
      await page.locator(".tryora__dialog [data-act=close]").click();
      expect(await page.locator(".tryora-assistant__actions-grid [data-ta=welcome]").count()).toBe(2);
      await page.locator("[data-action=visualise]").click();
      await page.locator("[data-file=upload]").setInputFiles({ name: "popup-room.jpg", mimeType: "image/jpeg", buffer: previewImage });
      await page.locator("[data-act=generate]:not(:disabled)").waitFor();
      expect(seen.previewStarts).toHaveLength(before);
      await page.locator("[data-act=generate]").click();
      await page.locator(".tryora-assistant__preview img").waitFor({ timeout: 15000 });
      expect(await page.locator(".tryora__dialog").count()).toBe(0);
      expect(await page.locator(".tryora-assistant__panel").isVisible()).toBe(true);
      expect(await page.locator(".tryora-assistant__preview [download]").count()).toBe(1);
      expect(seen.previewStarts).toHaveLength(before + 1);
      await expect.poll(() => seen.acks).toBe(acksBefore + 1);
      // Minimise/reopen must retain the delivered result and its original photo.
      const image = await page.locator(".tryora-assistant__preview img").getAttribute("src");
      await page.locator("[data-ta=minimise]").click();
      await page.locator(".tryora-assistant-launch").click();
      expect(await page.locator(".tryora-assistant__preview img").getAttribute("src")).toBe(image);
      await page.locator("[data-ta=compare][data-source=original]").click();
      expect(await page.locator(".tryora-assistant__preview img").getAttribute("src")).not.toBe(image);
      expect(seen.previewStarts).toHaveLength(before + 1);
      await shot(page, `popup-to-chat-${width}`);
    } finally { await context.close(); }
  }, 30000);

  it.each([1280, 390])("chat preview stays in the assistant and the standalone popup remains independent at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
    await routeImages(context);
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.locator(".tryora-assistant-launch").click();
      await page.locator("[data-action='recommend']").click();
      await page.locator(".tryora-assistant__photo-screen").waitFor();
      const before = seen.previewStarts.length, acksBefore = seen.acks;
      await page.locator("[data-ta-file=upload]").setInputFiles({ name: "room.jpg", mimeType: "image/jpeg", buffer: previewImage });
      // The photo-first flow submits the photo for analysis immediately, never for paid generation.
      await page.locator(".tryora-assistant__user-photo").waitFor();
      await page.locator("[data-ta=send]:not(:disabled)").waitFor();
      expect(seen.previewStarts).toHaveLength(before);
      await page.fill("textarea", "Show Aria Upholstered Bed in my room.");
      await page.locator("[data-ta=send]").click();
      await page.locator(".tryora-assistant__visualise [data-ta=preview]").waitFor({ timeout: 15000 });
      expect(await page.locator(".tryora__dialog").count()).toBe(0);
      await page.locator(".tryora-assistant__visualise [data-ta=preview]").click();
      await page.locator("[data-ta=confirm-preview]").waitFor();
      expect(seen.previewStarts).toHaveLength(before);
      await page.locator("[data-ta=confirm-preview]").click();
      await page.locator(".tryora-assistant__preview img").waitFor({ timeout: 15_000 });
      expect(await page.locator(".tryora__dialog").count()).toBe(0);
      expect(await page.locator(".tryora-assistant__panel").isVisible()).toBe(true);
      expect(seen.previewStarts).toHaveLength(before + 1);
      expect(seen.previewStarts.at(-1)!.variant).toBe(aria.variants[0]!.id);
      expect(await page.locator(".tryora-assistant__preview [download]").count()).toBe(1);
      await expect.poll(() => seen.acks).toBe(acksBefore + 1);
      await shot(page, `handoff-${width}-chat-result`);

      // Original store launcher: starts with its own state and keeps the image in its own popup.
      await page.locator("[data-ta=minimise]").click();
      await page.locator(".tryora-launch").click();
      await page.locator(".tryora__dialog [data-act=upload]").waitFor();
      await page.locator("[data-file=upload]").setInputFiles({ name: "room-2.jpg", mimeType: "image/jpeg", buffer: previewImage });
      await page.locator("[data-act=generate]:not(:disabled)").waitFor();
      await page.locator("[data-act=generate]").click();
      await expect.poll(() => page.locator(".tryora__h").textContent(), { timeout: 15_000 }).toContain("Your room, with");
      expect(await page.locator(".tryora__dialog .tryora__img").count()).toBe(1);
      expect(await page.locator(".tryora-assistant__panel").isVisible()).toBe(false);
      await expect.poll(() => seen.acks).toBe(acksBefore + 2);
      await shot(page, `handoff-${width}-original-popup-result`);
      await page.locator(".tryora__x[data-act=close]").click();
      await page.locator(".tryora-assistant-launch").click();
      expect(await page.locator(".tryora-assistant__preview img").count()).toBe(1);
      expect(await page.locator("form[action='/cart/add'] [name='id']").inputValue()).toBe(aria.variants[0]!.id.split("/").pop());
    } finally { await context.close(); }
  }, 60_000);

  it("desktop: launchers coexist, drawer streams grounded answers, modes and history work", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await routeImages(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin);
    const assistantLauncher = page.locator(".tryora-assistant-launch");
    const previewLauncher = page.locator(".tryora-launch");
    await assistantLauncher.waitFor();
    await previewLauncher.waitFor();
    const a = await assistantLauncher.boundingBox();
    const b = await previewLauncher.boundingBox();
    // Both visible, same corner, not overlapping.
    expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    expect(await assistantLauncher.textContent()).toContain("Room Assistant");
    await shot(page, "01-desktop-launchers");

    await assistantLauncher.click();
    const panel = page.locator(".tryora-assistant__panel");
    await panel.waitFor();
    await settled(page);
    const box = await panel.boundingBox();
    expect(Math.round(box.width)).toBe(440);
    expect(Math.round(box.x + box.width)).toBe(1280 - 12);
    expect(await page.locator(".tryora-assistant__backdrop").isVisible()).toBe(false);
    expect(await page.locator("[data-ta='welcome']").count()).toBe(2);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    await shot(page, "02-desktop-welcome");

    // Streaming: record every change of the answer text with a timestamp.
    await page.evaluate(() => {
      (window as any).__snapshots = [];
      new MutationObserver(() => {
        const text = document.querySelector(".tryora-assistant__message--assistant .tryora-assistant__text")?.textContent ?? "";
        const list = (window as any).__snapshots;
        if (text && list.at(-1)?.text !== text) list.push({ text, at: performance.now() });
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.fill("textarea", "Do you have grey beds?");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta")).toBe("stop");
    await page.locator(".tryora-assistant__card").first().waitFor({ timeout: 15_000 });
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    const snapshots: { text: string; at: number }[] = await page.evaluate(() => (window as any).__snapshots);
    const final = snapshots.at(-1)!.text;
    expect(final).toBe("Here are two verified options from the store. Option 1 suits a bright, calm room.");
    // Genuine incremental delivery over HTTP long-polling: several partial states, spread over time.
    const partial = snapshots.filter((entry) => entry.text !== final && final.startsWith(entry.text.trim()));
    expect(partial.length).toBeGreaterThanOrEqual(3);
    expect(snapshots.at(-1)!.at - snapshots[0]!.at).toBeGreaterThan(GAP_MS * 3);
    const cards = await page.locator(".tryora-assistant__card h4").allTextContents();
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(products.some((product) => cards.includes(product.title))).toBe(true);
    expect(await page.locator(".tryora-assistant__card .tryora-assistant__badge").count()).toBe(0);
    expect(await page.locator(".tryora-assistant__card .tryora-assistant__price").first().textContent()).toMatch(/\d/);
    await shot(page, "03-desktop-answer");

    // Fullscreen, restore, minimise, reopen.
    await page.click("[data-ta='view']");
    expect(Math.round((await panel.boundingBox()).width)).toBe(1280);
    await shot(page, "04-desktop-fullscreen");
    await page.click("[data-ta='view']");
    expect(Math.round((await panel.boundingBox()).width)).toBe(440);
    await page.click("[data-ta='minimise']");
    expect(await panel.isVisible()).toBe(false);
    expect(await assistantLauncher.isVisible()).toBe(true);
    await assistantLauncher.click();
    expect(await page.locator(".tryora-assistant__message").count()).toBe(2);

    // Refresh: the drawer reopens with the conversation.
    await page.reload();
    await page.locator(".tryora-assistant__panel").waitFor();
    expect(await page.locator(".tryora-assistant__message--user").first().textContent()).toContain("Do you have grey beds?");
    expect(await page.locator(".tryora-assistant__card").count()).toBeGreaterThanOrEqual(1);
    const stored = await page.evaluate((key: string) => sessionStorage.getItem(key), `tryora_assistant_v2:${SHOP}`);
    expect(stored).not.toContain("blob:");
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  it.each([1280, 390])("room photo, three grounded recommendations and a conversational preview at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390 }); await routeImages(context);
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator(".tryora-assistant-launch").click();
    await page.locator(".tryora-assistant__panel").waitFor();
    const room = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#e8e2d6" } }).jpeg().toBuffer();
    await page.setInputFiles("[data-ta-file='upload']", { name: "bedroom.jpg", mimeType: "image/jpeg", buffer: room });
    await page.locator("[data-ta-attachment] img").waitFor();
    await shot(page, `live-${width}-attachment`);
    await page.fill("textarea", "Recommend three beds for my room");
    await page.click("[data-ta='send']");
    await page.locator(".tryora-assistant__room-chip").waitFor({ timeout: 15_000 });
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    expect(seen.turnsWithPhoto).toBe(1);
    expect(await page.locator(".tryora-assistant__room-chip").textContent()).toContain("Scandinavian");
    expect(await page.locator(".tryora-assistant__user-photo").count()).toBe(1);

    expect(await page.locator(".tryora-assistant__card").count()).toBe(3);
    await shot(page, `live-${width}-room-recommendations`);
    // Ask for a visualisation of the verified Aria variant and confirm the card.
    await page.fill("textarea", "Show the Aria in cream in my room");
    await page.click("[data-ta='send']");
    const offer = page.locator(".tryora-assistant__visualise [data-ta='preview']");
    await offer.waitFor({ timeout: 15_000 });
    expect(seen.turnsWithPhoto).toBe(1); // the follow-up did not re-upload the photo
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    await shot(page, `live-${width}-conversational-preview-offer`);
    await offer.click();
    await page.locator(".tryora-assistant__preview img").waitFor({ timeout: 15_000 });
    const start = seen.previewStarts.at(-1)!;
    expect(start).toMatchObject({ product: aria.id, option: "Cream", variant: aria.variants.find((variant) => variant.selectedOptions[0]!.value === "Cream")!.id });
    expect(start.photo).toMatch(/^blob:\d+$/);
    await expect.poll(() => seen.acks).toBe(1);
    await shot(page, `live-${width}-preview-in-chat`);
    await context.close();
  }, 90_000);

  it.each([1280, 390])("appearance cards use store images/prices and exact View details navigation at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 }); await routeImages(context);
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.locator(".tryora-assistant-launch").click();
      await page.locator("[data-action=recommend]").click();
      await page.locator("[data-ta-file=upload]").setInputFiles({ name: "room.jpg", mimeType: "image/jpeg", buffer: previewImage });
      await page.locator("[data-ta-attachment] img").waitFor();
      await page.fill("textarea", "Which beds suit this room?"); await page.locator("[data-ta=send]").click();
      await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15000 }).toBe("send");
      const card = page.locator(".tryora-assistant__card", { hasText: "Aria Upholstered Bed" }); await card.waitFor();
      expect(await card.locator(".tryora-assistant__price").textContent()).toContain("899.00");
      expect(await card.locator(".tryora-assistant__thumb img").getAttribute("src")).toContain("cdn.shopify.com");
      expect(await card.locator(".tryora-assistant__badge").count()).toBe(0);
      // The card's own description, not a shared one.
      expect(await card.locator(".tryora-assistant__card-reason").textContent()).toBe("The Aria Upholstered Bed brings a colour and shape that suit the room.");
      expect(await card.locator(".tryora-assistant__card-body").textContent()).not.toMatch(/Size|King/);
      expect(await card.locator(".tryora-assistant__card-actions").textContent()).toContain("Preview in my room");
      expect(await page.locator("[data-ta-room] [data-ta=edit-room]").count()).toBe(1);
      expect(await page.locator("[data-ta-room] [data-ta=forget-room]").count()).toBe(1);
      const bounds = await card.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, scroll: el.scrollWidth, width: el.clientWidth }; });
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
      await shot(page, `final-polish-${width}-recommendations`);
      if (width === 1280) { await page.locator("[data-ta=view]").click(); await shot(page, "final-polish-fullscreen-recommendations"); }
      const link = card.locator(".tryora-assistant__card-actions a", { hasText: "View details" });
      const target = await link.getAttribute("href"); expect(target).toContain(`/products/${aria.handle}`);
      await link.click(); await page.waitForURL(new URL(target!, origin).href);
      expect(page.url()).toBe(new URL(target!, origin).href);
      expect(seen.previewStarts).toHaveLength(0);
      // The product page loads normally: the launcher is there, and the assistant does not open by itself.
      await page.locator(".tryora-assistant-launch").waitFor();
      await page.waitForTimeout(400);
      await shot(page, `view-details-${width}-product-page`);
      expect(await page.locator(".tryora-assistant__panel").isVisible()).toBe(false);
      // The shopper can still reopen it, with the same conversation and cards.
      await page.locator(".tryora-assistant-launch").click();
      await page.locator(".tryora-assistant__panel").waitFor();
      expect(await page.locator(".tryora-assistant__card", { hasText: "Aria Upholstered Bed" }).count()).toBeGreaterThan(0);
    } finally { await context.close(); }
  }, 60000);

  it("desktop: in-card fabric/colour selection and the in-chat email step lead to a delivered preview", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await routeImages(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    const startsBefore = seen.previewStarts.length;
    await page.goto(`${origin}/?lead=1`);
    await page.locator(".tryora-assistant-launch").click();
    await page.locator(".tryora-assistant__panel").waitFor();
    const room = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#e8e2d6" } }).jpeg().toBuffer();
    await page.setInputFiles("[data-ta-file='upload']", { name: "bedroom.jpg", mimeType: "image/jpeg", buffer: room });
    await page.locator("[data-ta-attachment] img").waitFor();
    await page.fill("textarea", "Which bed would look best in this room?");
    await page.click("[data-ta='send']");
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    const ariaCard = page.locator(".tryora-assistant__card", { hasText: "Aria Upholstered Bed" });
    await ariaCard.waitFor();
    // Change the exact option on the card: real Shopify variants, swatches from the product page's model.
    // The real fabric/colour choices are already on the card; no extra button opens them.
    await ariaCard.locator(".tryora-assistant__swatch[data-value='Cream']").waitFor();
    expect(await ariaCard.locator(".tryora-assistant__card-actions > *").allTextContents()).toEqual(["View details", "Preview in my room"]);
    await settled(page);
    await shot(page, "09-card-options");
    await ariaCard.locator(".tryora-assistant__swatch[data-value='Cream']").click();
    await expect.poll(() => ariaCard.locator(".tryora-assistant__optgroup legend").first().textContent()).toContain("Cream");
    // Preview turns on only once the server has confirmed this exact variant.
    await expect.poll(() => ariaCard.locator("[data-ta='preview']").isEnabled()).toBe(true);
    await shot(page, "09b-card-preview-ready");
    await ariaCard.locator("[data-ta='preview']").click();
    // The store requires an email first: one inline form, then the preview continues.
    const form = page.locator(".tryora-assistant__lead");
    await form.waitFor();
    await ariaCard.locator("[data-ta='preview']").click();
    expect(await page.locator(".tryora-assistant__lead").count()).toBe(1);
    expect(seen.previewStarts.length).toBe(startsBefore);
    await form.locator("input[name='ta-lead-email']").fill("shopper@example.com");
    await form.locator("input[name='ta-lead-marketing']").check();
    await settled(page);
    await shot(page, "10-email-step");
    await form.locator("[data-ta='lead-submit']").click();
    await page.locator(".tryora-assistant__preview img").waitFor({ timeout: 15_000 });
    expect(seen.leads).toEqual([expect.objectContaining({ email: "shopper@example.com", marketing: "1", product: aria.id, option: "Cream" })]);
    const cream = aria.variants.find((variant) => variant.selectedOptions[0]!.value === "Cream")!;
    expect(seen.previewStarts.at(-1)).toMatchObject({ product: aria.id, option: "Cream", variant: cream.id, leadDone: "1" });
    await expect.poll(() => seen.acks).toBeGreaterThan(0);
    await settled(page);
    await shot(page, "11-preview-after-email");
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  it("desktop: the card the shopper selects stays selected; the model cannot swap in another product", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await routeImages(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".tryora-assistant-launch").click();
    await page.locator(".tryora-assistant__panel").waitFor();
    await page.fill("textarea", "Suggest some beds");
    await page.click("[data-ta='send']");
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    const cards = page.locator(".tryora-assistant__card");
    await expect.poll(() => cards.count()).toBe(2);
    // Pressing Preview makes a card the shopper's choice (without a room photo it asks for one). Only a previewable card can be pressed.
    await expect.poll(() => cards.evaluateAll((nodes: Element[]) => nodes.findIndex((node) => !(node.querySelector("[data-ta='preview']") as HTMLButtonElement).disabled))).toBeGreaterThanOrEqual(0);
    const pick = await cards.evaluateAll((nodes: Element[]) => nodes.findIndex((node) => !(node.querySelector("[data-ta='preview']") as HTMLButtonElement).disabled));
    const second = cards.nth(pick), other = cards.nth(1 - pick);
    const chosen = (await second.locator("h4").textContent())!;
    await second.locator("[data-ta='preview']").click();
    await expect.poll(() => second.getAttribute("class")).toContain("is-selected");
    await page.fill("textarea", "select one");
    await page.click("[data-ta='send']");
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    // The latest reply shows the product the shopper chose, and only that product is marked selected.
    const focus = page.locator(".tryora-assistant__message--assistant").last().locator(".tryora-assistant__card");
    await expect.poll(() => focus.count()).toBe(1);
    expect(await focus.locator("h4").textContent()).toBe(chosen);
    expect(await focus.locator(".tryora-assistant__eyebrow").textContent()).toBe("Selected for your room \u00b7 Option 1");
    expect(await focus.locator(".tryora-assistant__thumb img").getAttribute("src")).toMatch(/^https:\/\/cdn\.shopify\.com\//);
    expect(await other.getAttribute("class")).not.toContain("is-selected");
    const stored = await page.evaluate((key: string) => JSON.parse(sessionStorage.getItem(key)!).selected, `tryora_assistant_v2:${SHOP}`);
    expect(stored.source).toBe("card");
    await settled(page);
    await shot(page, "12-card-selection-kept");
    expect(errors).toEqual([]);
    await context.close();
  }, 90_000);

  it("SSE transport delivers incrementally over a real HTTP connection", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await routeImages(context);
    const page = await context.newPage();
    await page.goto(`${origin}/sse`);
    await page.locator(".tryora-assistant-launch").click();
    await page.evaluate(() => {
      (window as any).__snapshots = [];
      new MutationObserver(() => {
        const text = document.querySelector(".tryora-assistant__message--assistant .tryora-assistant__text")?.textContent ?? "";
        const list = (window as any).__snapshots;
        if (text && list.at(-1)?.text !== text) list.push({ text, at: performance.now() });
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const streamed = page.waitForResponse((response: any) => response.url().endsWith("/apps/tryora/assistant/stream"));
    await page.fill("textarea", "grey beds please");
    await page.keyboard.press("Enter");
    expect((await streamed).headers()["content-type"]).toMatch(/text\/event-stream/);
    await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    const snapshots: { text: string }[] = await page.evaluate(() => (window as any).__snapshots);
    expect(snapshots.length).toBeGreaterThanOrEqual(4);
    expect(snapshots.at(-1)!.text).toContain("Option 1 suits a bright, calm room.");
    await context.close();
  }, 60_000);

  it("mobile: fullscreen layout, fixed header and composer, no horizontal overflow", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await routeImages(context);
    const page = await context.newPage();
    await page.goto(origin);
    const launcher = page.locator(".tryora-assistant-launch");
    await launcher.waitFor();
    const lb = await launcher.boundingBox();
    expect(lb.x + lb.width).toBeLessThanOrEqual(390);
    await shot(page, "07-mobile-launchers");
    await launcher.tap();
    const panel = page.locator(".tryora-assistant__panel");
    await panel.waitFor();
    await settled(page);
    const box = await panel.boundingBox();
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, 390, 844]);
    expect(await page.locator("[data-ta='view']").isVisible()).toBe(false);
    expect(await page.locator(".tryora-assistant__menu--attach").isVisible()).toBe(false);
    await page.tap("[data-ta='attach']");
    expect(await page.locator("[data-ta-camera]").isVisible()).toBe(true);
    await page.tap("[data-ta='photo-sheet-close']");
    for (let i = 0; i < 3; i += 1) {
      await page.fill("textarea", `grey beds ${i}`);
      await page.tap("[data-ta='send']");
      await expect.poll(() => page.locator(".tryora-assistant__send").getAttribute("data-ta"), { timeout: 15_000 }).toBe("send");
    }
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".tryora-assistant__header")!.getBoundingClientRect();
      const composer = document.querySelector(".tryora-assistant__composer")!.getBoundingClientRect();
      const scroll = document.querySelector<HTMLElement>(".tryora-assistant__scroll")!;
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        panelOverflow: document.querySelector(".tryora-assistant__panel")!.scrollWidth - window.innerWidth,
        headerTop: header.top, composerBottom: composer.bottom, height: window.innerHeight,
        scrolls: scroll.scrollHeight > scroll.clientHeight, pageLocked: getComputedStyle(document.documentElement).overflow,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.panelOverflow).toBeLessThanOrEqual(0);
    expect(layout.headerTop).toBe(0);
    expect(Math.round(layout.composerBottom)).toBe(layout.height);
    expect(layout.scrolls).toBe(true);
    expect(layout.pageLocked).toBe("hidden");
    await shot(page, "08-mobile-conversation");
    await context.close();
  }, 120_000);
});
