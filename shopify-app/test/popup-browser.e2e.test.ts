/** Real Chrome rendering of the built popup with synthetic product/proxy data.
 * Opt in with TRYORA_E2E=1. No Shopify, OpenAI or production calls are made. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const chrome = [
  process.env.TRYORA_E2E_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((path) => path && existsSync(path));
let browser: any;
const assets = join(__dirname, "../extensions/tryora-theme/assets");
const variant = (id: string, Fabric: string, Colour: string) => ({
  id, image: null, options: { Fabric, Colour, Size: "King", Headboard: "Tall", Storage: "None" },
});
const variants = [variant("1", "Velvet", "Cream"), variant("2", "Velvet", "Grey"), variant("3", "Boucle", "Oat")];
const base = {
  enabled: true, available: true, productId: "gid://shopify/Product/1", product: "Synthetic Bed",
  productImage: null, itemNoun: "bed", placement: "replace", setting: "indoor",
  optionName: "Colour", selectorLabel: "Colour", fabricOptionName: "Fabric",
  selectionOptionNames: ["Fabric", "Colour"], productVariants: variants, singleVariants: [],
  swatches: variants.map((v) => ({
    value: JSON.stringify([v.options.Fabric, v.options.Colour]), label: v.options.Colour,
    group: v.options.Fabric, available: true, variants: [v],
    image: v.id === "1" ? "/sample.svg" : null, colour: null,
  })),
  style: { template: "gallery", accent: null, useThemeFont: false },
  launcher: { mode: "tryora", type: "floating", showOnMobile: true, showOnDesktop: true, wording: "Preview",
    position: "bottom-right", offsetPx: { x: 16, y: 16 }, radiusPx: 12 },
  lead: { mode: "off", timing: "before" },
};

async function open(config: any, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.route("**/*", async (route: any) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/assets/tryora.js" || path === "/assets/tryora.css") {
      return route.fulfill({ contentType: path.endsWith(".js") ? "application/javascript" : "text/css", body: readFileSync(join(assets, path.split("/").pop()!)) });
    }
    if (path.endsWith("/assistant/config")) return route.fulfill({ json: { enabled: false } });
    if (path.endsWith("/config")) return route.fulfill({ json: config });
    if (path === "/sample.svg") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="#eee"/></svg>' });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/assets/tryora.css"><title>Synthetic shop</title></head><body>
      <form action="/cart/add"><input name="id" value="1"></form><a href="#tryora">Preview</a>
      <div hidden id="tryora-root" data-page-type="product" data-product-id="1"></div>
      <script defer src="/assets/tryora.js"></script></body></html>` });
  });
  const page = await context.newPage();
  await page.goto("https://tryora-fixture.test");
  await page.locator(".tryora-launch").waitFor();
  await page.locator('a[href="#tryora"]').click();
  await page.locator(".tryora__dialog").waitFor();
  return { page, context };
}

describe.skipIf(process.env.TRYORA_E2E !== "1")("premium popup in Chrome (synthetic)", () => {
  beforeAll(async () => {
    if (!chrome) throw new Error("Chrome/Edge not found");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: chrome, headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it.each([1280, 390])("shows only real colours with circular samples at %ipx", async (width) => {
    const { page, context } = await open(base, width);
    try {
      expect(await page.locator(".tryora__sname").allTextContents()).toEqual(["Cream"]);
      const sample = page.locator(".tryora__s img");
      expect(await sample.getAttribute("src")).toBe("/sample.svg");
      expect(await page.locator(".tryora__chip").first().evaluate((e: Element) => getComputedStyle(e).borderRadius)).toBe("50%");
      await page.locator('[data-act="fabric"][data-value="Boucle"]').click();
      expect(await page.locator('.tryora__s').allTextContents()).toEqual(["Oat"]);
      expect(await page.locator('.tryora__s[aria-checked="true"]').getAttribute("data-value")).toBe('["Boucle","Oat"]');
      expect(await page.locator('form [name="id"]').inputValue()).toBe("1");
      const chip = await page.locator(".tryora__chip").boundingBox();
      const dialog = await page.locator(".tryora__dialog").boundingBox();
      expect(chip.x).toBeGreaterThanOrEqual(dialog.x);
      expect(chip.x + chip.width).toBeLessThanOrEqual(dialog.x + dialog.width);
    } finally { await context.close(); }
  });

  it.each([1280, 390])("does not overlap long fabric labels or invent colours at %ipx", async (width) => {
    const labels = ["Plush Velvet", "Teddy Boucle", "Linoso", "Naples", "Chenille"];
    const source = { id: "1", image: null, options: { Fabric: labels[0], Size: "King", Composite: "opaque cream tuple" } };
    const config = { ...base, fabricOptionName: null, optionName: "Fabric", selectorLabel: "Fabric",
      selectionOptionNames: ["Fabric"], productVariants: [source],
      swatches: labels.map((value, i) => ({ value, label: value, group: null, image: null, colour: null,
        available: true, variants: i ? [{ ...source, id: String(i + 1), options: { ...source.options, Fabric: value, Composite: "different exact tuple" } }] : [source] })) };
    const { page, context } = await open(config, width);
    try {
      expect(await page.locator(".tryora__s:disabled").count()).toBe(4);
      expect(await page.locator(".tryora__sold").count()).toBe(0);
      expect(await page.locator(".tryora__s img").count()).toBe(0);
      expect(await page.locator(".tryora__sw").textContent()).toContain("Colour choices have not been mapped");
      const chips = await page.locator(".tryora__chip").evaluateAll((elements: Element[]) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          fits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight };
      }));
      expect(chips.every((chip: any) => chip.fits)).toBe(true);
      for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) {
        const a = chips[i], b = chips[j];
        expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
      }
    } finally { await context.close(); }
  });
});
