/** Real React + Polaris admin, real route actions, isolated Shopify/Prisma fixtures. No merchant writes. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFixture, productId, shopId } from "./fixtures/provider-mapping";
const state = vi.hoisted(() => ({ rows: [] as any[], admin: null as any, uploads: 0, media: [] as any[], marker: "" }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: async () => ({ admin: state.admin, session: { shop: "synthetic.myshopify.com" } }) } }));
vi.mock("../app/db.server", () => {
  const db = { shop: { upsert: async () => ({}) }, productPreviewConfig: { findUnique: async () => ({ enabled: true, autoConfigured: false, visualOptionName: "Colour", choices: [] }) },
    customizationConfig: {
      findMany: async ({ where }: any) => state.rows.filter((r) => r.shopId === where.shopId && where.productId.in.includes(r.productId)),
      findUnique: async ({ where }: any) => state.rows.find((r) => r.shopId === where.shopId_productId.shopId && r.productId === where.shopId_productId.productId) ?? null,
      create: async ({ data }: any) => { state.rows.push(data); return data; },
      updateMany: async ({ where, data }: any) => { const row = state.rows.find((r) => r.shopId === where.shopId && r.productId === where.productId && r.revision === where.revision); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    } };
  return { default: { ...db, $transaction: async (fn: any) => fn(db) } };
});
import { loader, action } from "../app/routes/app.fabrics";
import { compileFabricDocument, draftFromMapping } from "../app/customization/fabric-manager.server";
const RUN = process.env.TRYORA_E2E === "1", SHOTS = process.env.TRYORA_E2E_SCREENSHOTS ?? "";
const nativeId = "gid://shopify/Product/2";
let browser: any, server: any, origin: string, bundle: string, polaris: string, jpeg: Buffer;
const browserPath = [process.env.TRYORA_E2E_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
const originalFetch = globalThis.fetch;
async function savePage(page: any) {
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.locator('button:has-text("Save changes")').click()]);
  await page.locator('[aria-label="Configuration mode"]').waitFor();
}
async function screenshot(page: any, name: string) { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); }
function fixture() {
  const f = providerFixture(); state.media = [...f.media, ...[202, 203].map((id) => ({ id: `gid://shopify/MediaImage/${id}`, image: { url: `https://cdn.shopify.com/${id}.jpg` } }))];
  const draft = draftFromMapping(f.mapping, shopId, productId);
  draft.fabrics[0]!.textureMediaId = "gid://shopify/MediaImage/202";
  draft.fabrics.push({ id: "boucle", name: "Teddy Boucle", enabled: true, description: "Actual merchant texture", textureMediaId: "gid://shopify/MediaImage/203",
    colours: [{ id: "boucle-ascot", name: "Ascot", enabled: true, swatchMediaId: "gid://shopify/MediaImage/203", hex: null }] });
  const { document } = compileFabricDocument(draft, shopId, productId, { product: {}, variants: f.variants, media: state.media });
  state.rows = [{ shopId, productId, providerId: "manual_mapping", revision: "initial", active: true, mapping: document }]; state.uploads = 0;
  state.admin = { graphql: async (q: string, init: any) => {
    const id = init?.variables?.id;
    if (q.includes("TryoraFabricProducts")) return Response.json({ data: { products: { nodes: [{ id: nativeId, title: "Native Bed" }, { id: productId, title: "Manual Bed" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("TryoraStageFabricImage")) return Response.json({ data: { stagedUploadsCreate: { stagedTargets: [{ url: "https://shopify-staged-uploads.storage.googleapis.com/", resourceUrl: "https://shopify-staged-uploads.storage.googleapis.com/image.jpg", parameters: [] }], userErrors: [] } } });
    if (q.includes("TryoraAttachFabricImage")) {
      state.marker = init.variables.media[0].alt; state.uploads++;
      state.media.push({ id: `gid://shopify/MediaImage/${900 + state.uploads}`, alt: state.marker, image: { url: `https://cdn.shopify.com/upload-${state.uploads}.jpg` } });
      return Response.json({ data: { productUpdate: { product: { id: productId }, userErrors: [] } } });
    }
    if (q.includes("TryoraFabricUploadStatus")) return Response.json({ data: { product: { id: productId, media: { nodes: state.media } } } });
    if (id !== nativeId && id !== productId) return Response.json({ data: { product: null } });
    if (q.includes("TryoraPreviewMedia")) return Response.json({ data: { product: { id, media: { nodes: state.media, pageInfo: { hasNextPage: false } } } } });
    if (id === productId) { const r = await f.context.admin.graphql(q, init); const data = await r.json(); data.data.product.title = "Manual Bed"; return Response.json(data); }
    const options = [{ name: "Fabric", optionValues: [{ name: "Velvet" }, { name: "Boucle" }] }, { name: "Colour", optionValues: [{ name: "Cream", swatch: { image: { image: { url: "https://cdn.shopify.com/201.jpg" } } } }, { name: "Grey", swatch: { color: "#888888" } }, { name: "Oat" }] }, { name: "Size", optionValues: [{ name: "King" }] }];
    const variants = [["Velvet", "Cream"], ["Velvet", "Grey"], ["Boucle", "Oat"]].map(([Fabric, Colour], i) => ({ id: `gid://shopify/ProductVariant/${21 + i}`, availableForSale: i !== 1, image: { url: `https://cdn.shopify.com/${101 + i}.jpg` }, selectedOptions: [{ name: "Fabric", value: Fabric }, { name: "Colour", value: Colour }, { name: "Size", value: "King" }] }));
    return Response.json({ data: { product: { id: nativeId, title: "Native Bed", options, variants: { nodes: variants, pageInfo: { hasNextPage: false } } } } });
  } };
}
describe.skipIf(!RUN)("Fabric manager actual admin in Chrome", () => {
  beforeAll(async () => {
    if (!browserPath) throw new Error("Chrome or Edge is required");
    vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true");
    const cached = join(tmpdir(), "tryora-polaris.js");
    polaris = existsSync(cached) ? readFileSync(cached, "utf8") : await (await originalFetch("https://cdn.shopify.com/shopifycloud/polaris.js")).text();
    jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#d0c3ae" } }).jpeg().toBuffer();
    vi.stubGlobal("fetch", async (input: any, init: any) => String(input).startsWith("https://shopify-staged-uploads.storage.googleapis.com/") ? new Response("", { status: 201 }) : originalFetch(input, init));
    const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{FabricColourManager}from'./app/components/fabric-colour-manager';
      const data=window.managerData;function App(){const[error,setError]=useState('');return <FabricColourManager data={data} error={error}
      save={async(mode,draft)=>{const r=await fetch(location.href,{method:'POST',body:new URLSearchParams({intent:'save',mode,revision:data.selected.revision,draft:JSON.stringify(draft)})});if(r.redirected){location.href=r.url;return}setError((await r.json()).error||'Save failed')}}
      upload={async(file)=>{const form=new FormData();form.set('intent','upload');form.set('revision',data.selected.revision);form.set('image',file);const r=await fetch(location.href,{method:'POST',body:form});const json=await r.json();if(json.error)throw Error(json.error);return json.media}}/>}createRoot(document.getElementById('root')).render(<App/>);`;
    bundle = (await build({ stdin: { contents: entry, loader: "tsx", resolveDir: join(__dirname, "..") }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0]!.text;
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", origin);
        if (url.pathname === "/manager.js") { res.setHeader("Content-Type", "application/javascript"); res.end(bundle); return; }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = new Request(url, { method: req.method, headers: { "content-type": String(req.headers["content-type"] ?? "") }, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
        if (req.method === "POST") {
          const result = await action({ request } as any);
          if (result instanceof Response) { res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text()); return; }
          res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return;
        }
        const data = await loader({ request } as any);
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="https://cdn.shopify.com/shopifycloud/polaris.js"></script><style>body{margin:0;background:#fafafa}#root{padding:16px}</style></head><body><div id="root"></div><script>window.managerData=${JSON.stringify(data).replace(/</g, "\\u003c")}</script><script src="/manager.js"></script></body></html>`);
      } catch (err) { res.writeHead(500); res.end("Local fixture error"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = await import("playwright-core"); browser = await chromium.launch({ executablePath: browserPath, headless: true });
  });
  beforeEach(() => { fixture(); vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "true"); vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", shopId); });
  afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server?.close(resolve)); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it.each(["rollout-off", "other-installation", "invalid-policy"])("locks manual controls and rejects forged actions for %s", async (condition) => {
    if (condition === "rollout-off") vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_ENABLED", "false");
    else vi.stubEnv("TRYORA_CUSTOMIZATION_PROVIDERS_SHOPS", condition === "invalid-policy" ? "*" : "another.myshopify.com");
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    await context.route("https://cdn.shopify.com/**", (r: any) => r.fulfill({ contentType: r.request().url().endsWith("polaris.js") ? "application/javascript" : "image/jpeg", body: r.request().url().endsWith("polaris.js") ? polaris : jpeg }));
    const page = await context.newPage(); const original = structuredClone(state.rows);
    try {
      await page.goto(`${origin}/app/fabrics?product=${encodeURIComponent(productId)}`);
      await page.locator('[aria-label="Configuration mode"]').waitFor();
      expect(await page.locator('[aria-label="Configuration mode"]').inputValue()).toBe("native");
      expect(await page.locator('[aria-label="Configuration mode"] option[value=manual]').getAttribute("disabled")).not.toBeNull();
      expect(await page.locator('button:has-text("Save changes")').isDisabled()).toBe(true);
      expect(await page.locator('button:has-text("+ Add fabric")').isDisabled()).toBe(true);
      expect(await page.locator('.fabric-workspace').count()).toBe(0);
      expect(await page.locator('s-banner[heading="Manual setup is not enabled"]').count()).toBe(1);
      expect(await page.locator('.fabric-manager').textContent()).toContain("Shopify-native previews continue to work");
      const response = await page.evaluate(async () => (await fetch(location.href, { method: 'POST', body: new URLSearchParams({ intent: 'save', mode: 'manual', shop: 'another.myshopify.com', draft: '{}' }) })).json());
      expect(response.error).toContain("authorization"); expect(state.rows).toEqual(original); expect(state.uploads).toBe(0);
      await screenshot(page, `manager-disabled-${condition}`);
    } finally { await context.close(); }
  });
  it.each([1280, 390])("native/manual modes, colour edits and real image upload/save at %ipx", async (width) => {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("https://cdn.shopify.com/**", (r: any) => r.fulfill({ contentType: r.request().url().endsWith("polaris.js") ? "application/javascript" : "image/jpeg", body: r.request().url().endsWith("polaris.js") ? polaris : jpeg }));
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(`${origin}/app/fabrics?product=${encodeURIComponent(nativeId)}`);
      await page.locator('[aria-label="Configuration mode"]').waitFor();
      expect(await page.locator('[aria-label="Configuration mode"] option').count()).toBe(2);
      expect(await page.locator('.fabric-manager').textContent()).toContain("Actual Shopify swatch image");
      expect(await page.locator('.fabric-manager').textContent()).toContain("Text label - no swatch supplied by Shopify");
      await page.evaluate(() => customElements.whenDefined("s-page"));
      await screenshot(page, `manager-native-${width}`);
      expect(state.rows).toHaveLength(1); // read-only native view
      await page.selectOption('[aria-label="Shopify product"]', productId);

      await page.locator('summary:has-text("Edit sample image")').first().waitFor();
      await screenshot(page, `manager-manual-colours-${width}`);
      expect(await page.locator('.fabric-manager').textContent()).toContain("Velvet");
      expect(await page.locator('.fabric-list-item[aria-pressed=true]').textContent()).toContain("Velvet");
      await page.locator('.fabric-list-item', { hasText: 'Teddy Boucle' }).click();
      expect(await page.locator('input[aria-label^="Colour name"]').count()).toBe(1);
      expect(await page.locator('input[aria-label^="Colour name"]').inputValue()).toBe("Ascot");
      await page.locator('.fabric-list-item', { hasText: 'Velvet' }).click();
      expect(await page.locator('input[aria-label^="Colour name"]').count()).toBe(2);
      await page.locator('button:has-text("+ Add colour")').click();
      const colour = page.locator('input[aria-label^="Colour name"]').last(); await colour.fill("Ascot");
      const row = colour.locator('xpath=ancestor::tr[1]');
      await row.locator('input[aria-label^="HEX "]').fill("#aabbcc");
      expect(await row.locator('input[aria-label^="RGB "]').inputValue()).toBe("170, 187, 204");
      await row.locator('input[aria-label^="RGB "]').fill("999, 2, 3");
      expect(await page.locator('button:has-text("Save changes")').isDisabled()).toBe(true);
      expect(await row.locator('[role=alert]').textContent()).toContain("0 to 255");
      await row.locator('input[aria-label^="RGB "]').fill("12, 34, 56");
      expect(await page.locator('button:has-text("Save changes")').isEnabled()).toBe(true);
      expect(await row.locator('input[aria-label^="HEX "]').inputValue()).toBe("#0c2238");
      await row.locator('input[aria-label^="HEX "]').fill("#aabbcc");
      await row.locator('input[type=file]').setInputFiles({ name: "actual-swatch.jpg", mimeType: "image/jpeg", buffer: jpeg });
      await expect.poll(() => state.uploads).toBe(1);
      await expect.poll(() => row.locator('select').inputValue()).toBe("gid://shopify/MediaImage/901");
      await savePage(page);

      await page.locator('summary:has-text("Edit sample image")').last().click();
      expect(await page.locator('input[aria-label^="Colour name"]').last().inputValue()).toBe("Ascot");
      const saved = state.rows[0].mapping.draft.fabrics[0].colours.at(-1);
      expect(saved).toMatchObject({ name: "Ascot", hex: "#aabbcc", swatchMediaId: "gid://shopify/MediaImage/901" });
      expect(state.rows[0].mapping.published.entries).toHaveLength(4);

      expect(await page.locator('select[aria-label^="Variant "]').count()).toBe(4);
      await screenshot(page, `manager-mapping-${width}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.locator('button:has-text("+ Add fabric")').click();
      await page.locator('input[aria-label^="Fabric name"]').last().fill("Loft Linen");
      await page.locator('.fabric-editor textarea').fill("Merchant-provided fabric description");
      await savePage(page);
      await expect.poll(() => state.rows[0].mapping.draft.fabrics.length).toBe(3);
      expect(state.rows[0].mapping.draft.fabrics.at(-1)).toMatchObject({ name: "Loft Linen", description: "Merchant-provided fabric description", enabled: true });
      await page.locator('.fabric-list-item', { hasText: 'Loft Linen' }).click();
      await page.locator('.fabric-editor summary').click();
      const newFabric = page.locator('.fabric-editor');
      await newFabric.locator('input[type=checkbox]').uncheck();
      await savePage(page);
      await expect.poll(() => state.rows[0].mapping.draft.fabrics.at(-1).enabled).toBe(false);
      page.on("dialog", (d: any) => d.accept());
      await page.locator('.fabric-list-item', { hasText: 'Loft Linen' }).click();
      await page.locator('.fabric-editor summary').click();
      await page.locator('.fabric-editor button:has-text("Remove fabric")').click();
      await savePage(page);
      await expect.poll(() => state.rows[0].mapping.draft.fabrics.length).toBe(2);
      expect(state.rows[0].mapping.published.entries).toHaveLength(4);
      await page.locator('button:has-text("+ Add mapping")').click();
      const incomplete = page.locator('.fabric-mapping tbody tr').last();
      expect(await incomplete.textContent()).toContain("Needs mapping");
      expect(await incomplete.locator('select[aria-label^="Variant "]').inputValue()).toBe("");
      await screenshot(page, `manager-incomplete-mapping-${width}`);
      await savePage(page);
      expect(state.rows[0].mapping.draft.bindings.at(-1).variantId).toBeNull();
      expect(state.rows[0].mapping.published.entries).toHaveLength(4);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 60_000);
});
