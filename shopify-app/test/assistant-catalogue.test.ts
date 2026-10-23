import { beforeEach, describe, expect, it } from "vitest";
import {
  CATALOGUE_PAGE_SIZE,
  getCatalogue,
  getProductDetails,
  invalidateAssistantCatalogue,
  liveSearch,
  MAX_INDEXED_PRODUCTS,
  parseProduct,
  resetAssistantCatalogueCache,
  searchCatalogue,
  setCatalogueClock,
  ShopifyBudget,
  snapshotFrom,
  type CatalogueProduct,
  type ProductQuery,
} from "../app/assistant/catalogue.server";
import { containsMeaning, expandQuery, sameMeaning, tokens } from "../app/assistant/text";
import { buildKnowledge, retrieveKnowledge } from "../app/assistant/knowledge.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { fixtureAdmin, fixtureProduct, furnitureCatalogue, type FixtureProduct } from "./fixtures/assistant-store";

setAssistantLogSink(() => {});

const query = (overrides: Partial<ProductQuery>): ProductQuery => ({
  query: "", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 6, ...overrides,
});

function parsed(products: FixtureProduct[]): CatalogueProduct[] {
  return products.map((product) => {
    const prices = product.variants.map((variant) => Number(variant.price));
    return parseProduct({
      ...product,
      ...Object.fromEntries(Object.entries(product.metafields).map(([key, value]) => [key, { value }])),
      priceRangeV2: { minVariantPrice: { amount: String(Math.min(...prices)), currencyCode: "GBP" }, maxVariantPrice: { amount: String(Math.max(...prices)), currencyCode: "GBP" } },
      variantsCount: { count: product.variants.length },
    }, product.variants, true)!;
  }).filter(Boolean);
}

const store = () => snapshotFrom("demo.myshopify.com", parsed([
  fixtureProduct({ id: 1, title: "Aria Upholstered Bed", productType: "Bed", options: { Colour: ["Grey", "Cream"], Size: ["Double", "King", "Super King"] }, price: (o) => o.Size === "Double" ? 449 : o.Size === "King" ? 549 : 649, available: (o) => !(o.Colour === "Cream" && o.Size === "King") }),
  fixtureProduct({ id: 2, title: "Oslo Couch", productType: "Sofa", options: { Colour: ["Gray", "Green"] }, price: 899, tags: ["living room"] }),
  fixtureProduct({ id: 3, title: "Pip Loveseat", productType: "Sofa", options: { Colour: ["Cream"] }, price: 399, description: "Space saving two seater for small spaces and apartments." }),
  fixtureProduct({ id: 4, title: "Hampton Bedside Table", productType: "Bedside Table", options: { Finish: ["Oak"] }, price: 129 }),
  fixtureProduct({ id: 5, title: "Luna Velvet Armchair", productType: "Chair", options: { Colour: ["Navy Blue", "Blush"] }, price: 349, available: () => false }),
  fixtureProduct({ id: 6, title: "Willow Divan", productType: "Bed", options: { Colour: ["Charcoal"], Size: ["King"] }, price: 480, metafields: { dimensions: JSON.stringify({ value: 160, unit: "CENTIMETERS" }), material: "Linen blend" } }),
]), true);

const titles = (matches: { product: CatalogueProduct }[]) => matches.map((match) => match.product.title);

describe("shopper vocabulary", () => {
  it("normalises synonyms, spelling variants and compound sizes", () => {
    expect(tokens("Grey couch")).toEqual(tokens("gray sofa"));
    expect(tokens("Bouclé settee")).toEqual(tokens("boucle sofa"));
    expect(sameMeaning("King Size", "king")).toBe(true);
    expect(sameMeaning("Super King", "King")).toBe(false);
    expect(containsMeaning("Super King", "King")).toBe(false);
    expect(containsMeaning("Light Grey Velvet", "gray")).toBe(true);
    expect(tokens("small double")).not.toContain("compact");
    expect(tokens("small room")).toContain("compact");
    expect(expandQuery("grey").map((term) => term.term)).toContain("charcoal");
  });
});

describe("catalogue search", () => {
  it("finds a sofa when the shopper says couch, and a couch when they say sofa", () => {
    expect(titles(searchCatalogue(store(), query({ query: "couch" })))).toEqual(expect.arrayContaining(["Oslo Couch", "Pip Loveseat"]));
    expect(titles(searchCatalogue(store(), query({ query: "sofa", colour: "grey" })))[0]).toBe("Oslo Couch");
  });

  it("matches bed to upholstered beds and divans, but never to bedside tables", () => {
    const results = titles(searchCatalogue(store(), query({ query: "bed" })));
    expect(results).toEqual(expect.arrayContaining(["Aria Upholstered Bed", "Willow Divan"]));
    expect(results).not.toContain("Hampton Bedside Table");
    expect(titles(searchCatalogue(store(), query({ query: "nightstand" })))).toEqual(["Hampton Bedside Table"]);
  });

  it("does not return the current product when it does not match the requested furniture", () => {
    const results = searchCatalogue(store(), query({ query: "green sofa", colour: "Green" }), "gid://shopify/Product/1");
    expect(titles(results)[0]).toBe("Oslo Couch");
    expect(titles(results)).not.toContain("Aria Upholstered Bed");
    // A sofa without green is offered only as a lower-ranked alternative, flagged for the model.
    expect(results.find((match) => match.product.title === "Pip Loveseat")?.unmatched).toEqual(["Green"]);
  });

  it("understands small rooms as compact furniture", () => {
    expect(titles(searchCatalogue(store(), query({ query: "sofa for a small room" })))[0]).toBe("Pip Loveseat");
  });

  it("applies budget and colour constraints to exact variants", () => {
    const [aria, ...rest] = searchCatalogue(store(), query({ query: "bed", colour: "grey", maxPrice: 500 }));
    expect(aria!.product.title).toBe("Aria Upholstered Bed");
    expect(aria!.matchingVariants.map((variant) => variant.options)).toEqual([{ Colour: "Grey", Size: "Double" }]);
    // Charcoal is related to grey, so the divan is still offered but ranked below an exact grey match.
    expect(titles(rest)).toContain("Willow Divan");
    expect(titles(searchCatalogue(store(), query({ query: "bed", maxPrice: 400 })))).toEqual([]);
  });

  it("distinguishes king from super king and reports sold-out variants", () => {
    const [aria] = searchCatalogue(store(), query({ query: "aria bed", colour: "cream", size: "king" }));
    expect(aria!.matchingVariants).toHaveLength(1);
    expect(aria!.matchingVariants[0]).toMatchObject({ options: { Colour: "Cream", Size: "King" }, available: false });
    expect(searchCatalogue(store(), query({ query: "armchair", availableOnly: true }))).toEqual([]);
    expect(titles(searchCatalogue(store(), query({ query: "armchair" })))).toEqual(["Luna Velvet Armchair"]);
  });

  it("reads merchant dimension and material metafields", () => {
    const divan = store().byRef.get("6")!;
    expect(divan.attributes).toEqual({ dimensions: "160 centimeters", material: "Linen blend" });
    expect(titles(searchCatalogue(store(), query({ query: "linen bed" })))[0]).toBe("Willow Divan");
  });

  it("excludes drafts and products not published to the Online Store", () => {
    const hidden = fixtureProduct({ title: "Secret Bed", productType: "Bed", options: { Size: ["King"] }, published: false });
    const draft = fixtureProduct({ title: "Draft Bed", productType: "Bed", options: { Size: ["King"] }, status: "DRAFT" });
    expect(parsed([hidden, draft])).toEqual([]);
  });
});

describe("catalogue loading and caching", () => {
  beforeEach(() => resetAssistantCatalogueCache());

  it("indexes every published product in a 500-product store, including ones without Tryora previews", async () => {
    const admin = fixtureAdmin(furnitureCatalogue(500));
    const { snapshot, cache } = await getCatalogue(admin, "big.myshopify.com", 10_000);
    expect(cache).toBe("miss");
    expect(snapshot!.products).toHaveLength(500);
    expect(snapshot!.complete).toBe(true);
    expect(admin.calls.TryoraAssistantCatalogue).toBe(Math.ceil(500 / CATALOGUE_PAGE_SIZE));
    // Variants are sampled in the index; exact data comes from getProductDetails.
    expect(snapshot!.products.every((product) => product.variants.length <= 20)).toBe(true);
  });

  it("caps very large stores and uses live Shopify search for the rest", async () => {
    const products = furnitureCatalogue(1200);
    const admin = fixtureAdmin(products);
    const { snapshot } = await getCatalogue(admin, "huge.myshopify.com", 20_000);
    expect(snapshot!.products).toHaveLength(MAX_INDEXED_PRODUCTS);
    expect(snapshot!.complete).toBe(false);
    const beyond = products.at(-1)!;
    expect(snapshot!.byRef.has(beyond.id.split("/").pop()!)).toBe(false);
    const live = await liveSearch(admin, "huge.myshopify.com", query({ query: beyond.title }), new ShopifyBudget());
    expect(live.products.map((product) => product.id)).toContain(beyond.id);
  });

  it("serves warm requests from cache, refreshes stale entries in the background and honours invalidation", async () => {
    let time = 1_000_000;
    setCatalogueClock(() => time);
    const admin = fixtureAdmin(furnitureCatalogue(60));
    await getCatalogue(admin, "demo.myshopify.com", 5_000);
    const loaded = admin.totalCalls();
    expect((await getCatalogue(admin, "demo.myshopify.com", 5_000)).cache).toBe("hit");
    expect(admin.totalCalls()).toBe(loaded);
    time += 6 * 60_000;
    expect((await getCatalogue(admin, "demo.myshopify.com", 5_000)).cache).toBe("stale");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(admin.totalCalls()).toBe(loaded * 2);
    invalidateAssistantCatalogue("demo.myshopify.com");
    expect((await getCatalogue(admin, "demo.myshopify.com", 5_000)).cache).toBe("miss");
  });

  it("never serves one merchant's catalogue to another", async () => {
    const a = fixtureAdmin([fixtureProduct({ title: "Alpha Only Sofa", productType: "Sofa", options: { Colour: ["Grey"] } })]);
    const b = fixtureAdmin([fixtureProduct({ title: "Beta Only Bed", productType: "Bed", options: { Colour: ["Grey"] } })]);
    const shopA = await getCatalogue(a, "alpha.myshopify.com", 5_000);
    const shopB = await getCatalogue(b, "beta.myshopify.com", 5_000);
    expect(shopA.snapshot!.shopId).toBe("alpha.myshopify.com");
    expect(shopB.snapshot!.products.map((product) => product.title)).toEqual(["Beta Only Bed"]);
    expect(titles(searchCatalogue(shopB.snapshot!, query({ query: "sofa" })))).toEqual([]);
    // A cached shop is not reused for a different shop even through the same admin client.
    expect((await getCatalogue(a, "beta.myshopify.com", 5_000)).snapshot!.products.map((product) => product.title)).toEqual(["Beta Only Bed"]);
  });

  it("returns a cold result instead of blocking a shopper when the first load is slow", async () => {
    const admin = fixtureAdmin(furnitureCatalogue(100), {}, { latencyMs: 50 });
    const { snapshot, cache } = await getCatalogue(admin, "slow.myshopify.com", 20);
    expect(snapshot).toBeNull();
    expect(cache).toBe("cold");
  });

  it("retries a throttled Shopify request once", async () => {
    const admin = fixtureAdmin(furnitureCatalogue(5), {}, { throttleFirst: true });
    const { snapshot } = await getCatalogue(admin, "throttled.myshopify.com", 5_000);
    expect(snapshot!.products).toHaveLength(5);
  });

  it("reads exact fresh details across variant pages", async () => {
    const big = fixtureProduct({ title: "Modular Sofa", productType: "Sofa", options: { Colour: COLOURS_30, Size: ["2 Seater", "3 Seater", "Corner", "Chaise", "Sofa Bed"] } });
    const admin = fixtureAdmin([big]);
    const details = await getProductDetails(admin, [big.id.split("/").pop()!, "not-a-ref"], new ShopifyBudget());
    const product = [...details.values()][0]!;
    expect(product.variants).toHaveLength(150);
    expect(product.variantsComplete).toBe(true);
    expect(admin.calls.TryoraAssistantProductDetail).toBe(2);
  });

  it("searches a 1,000-product index fast enough for interactive chat", () => {
    const snapshot = snapshotFrom("demo.myshopify.com", parsed(furnitureCatalogue(1000)), true);
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) searchCatalogue(snapshot, query({ query: "bed", colour: "grey", size: "king", material: "velvet", maxPrice: 900, availableOnly: true }));
    // Guards against per-variant re-tokenising, which once made one search take ~2 s on 500 products.
    expect((performance.now() - started) / 5).toBeLessThan(250);
  });

  it("enforces the per-request Shopify call budget", async () => {
    const admin = fixtureAdmin(furnitureCatalogue(5));
    const budget = new ShopifyBudget(1);
    await liveSearch(admin, "demo.myshopify.com", query({ query: "bed" }), budget);
    await expect(liveSearch(admin, "demo.myshopify.com", query({ query: "bed" }), budget)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

const COLOURS_30 = Array.from({ length: 30 }, (_, i) => `Colour ${i}`);

describe("store knowledge retrieval", () => {
  const longRefund = [
    "Returns. You may return most items within 30 days of delivery for a full refund.",
    ...Array.from({ length: 40 }, (_, i) => `Clause ${i + 1}. Items must be unused and in original packaging, and collection is arranged by our team.`),
    "Made to order. Bespoke and made-to-order upholstery cannot be returned unless faulty.",
  ].join("\n\n");
  const knowledge = buildKnowledge("demo.myshopify.com", {
    shopName: "Demo Furniture",
    contactEmail: "hello@demo.example",
    policies: [
      { type: "REFUND_POLICY", title: "Refund policy", url: "/policies/refund-policy", body: `<p>${longRefund.replace(/\n\n/g, "</p><p>")}</p>` },
      { type: "SHIPPING_POLICY", title: "Shipping policy", url: "/policies/shipping-policy", body: "<h2>Delivery</h2><p>Standard delivery takes 5 to 10 working days. Two-person delivery costs £49.</p>" },
    ],
    pages: [{ title: "FAQ", handle: "faq", body: "<p>Do you have a showroom? Yes, our Leeds showroom is open Saturday 10am to 4pm.</p>", isPublished: true },
      { title: "Hidden", handle: "hidden", body: "<p>Internal draft about a secret sale.</p>", isPublished: false }],
    notes: "We deliver to mainland UK only. Assembly is available for beds at £35.",
    pagesAvailable: true,
  });

  it("keeps late clauses of long policies retrievable instead of truncating them", () => {
    const sections = retrieveKnowledge(knowledge, "can I return bespoke made to order sofa");
    expect(sections[0]!.text).toContain("Bespoke and made-to-order upholstery cannot be returned");
    expect(knowledge.sections.filter((section) => section.source === "policy").length).toBeGreaterThan(2);
  });

  it("retrieves shipping, FAQ pages, merchant notes and contact details", () => {
    expect(retrieveKnowledge(knowledge, "delivery time cost")[0]!.text).toContain("5 to 10 working days");
    expect(retrieveKnowledge(knowledge, "showroom opening")[0]!.url).toBe("/pages/faq");
    expect(retrieveKnowledge(knowledge, "do you deliver to Northern Ireland mainland")[0]!.source).toBe("merchant_notes");
    expect(retrieveKnowledge(knowledge, "contact email")[0]!.text).toContain("hello@demo.example");
    expect(knowledge.sections.some((section) => section.text.includes("secret sale"))).toBe(false);
  });

  it("bounds what is sent to the model per question", () => {
    const sections = retrieveKnowledge(knowledge, "returns refund delivery items", 4);
    expect(sections.length).toBeLessThanOrEqual(4);
    expect(sections.every((section) => section.text.length <= 1100)).toBe(true);
  });
});
