/**
 * Regression suite for the production incident on test-sofa-site.myshopify.com: a shopper on the Egerie Curved
 * Headboard Beige Boucle Bed page was told the store "does not have any beds available for sale".
 *
 * Root cause: the catalogue/live-search query requested 1,782 cost points; Shopify rejects queries over 1,000 with
 * MAX_COST_EXCEEDED, so every product search failed, the model saw no products, and it invented an absence claim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ configs: [] as any[] }));
vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => null) },
    productPreviewConfig: { findMany: vi.fn(async () => state.configs) },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));

import { answerRoomAssistant, guardAbsenceClaims } from "../app/room-assistant.server";
import { runAssistantDiagnostics } from "../app/assistant/diagnostics.server";
import {
  CATALOGUE_QUERY,
  getCatalogue,
  MAX_INDEXED_PRODUCTS,
  PRODUCT_COUNT_QUERY,
  PRODUCT_DETAIL_QUERY,
  resetAssistantCatalogueCache,
} from "../app/assistant/catalogue.server";
import { STORE_INFO_QUERY, STORE_PAGES_QUERY } from "../app/assistant/knowledge.server";
import { PREVIEW_PRODUCT_QUERY } from "../app/preview-product.server";
import { resetAssistantKnowledgeCache } from "../app/assistant/knowledge.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";
import { requestedQueryCost, SHOPIFY_MAX_QUERY_COST } from "./fixtures/query-cost";
import { finalAnswer, fixtureAdmin, fixtureProduct, furnitureCatalogue, ref, scriptedModel, toolCall, toolOutputs } from "./fixtures/assistant-store";

const SHOP = "test-sofa-site.myshopify.com";
const settings = { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true };
const logs: any[] = [];

const egerie = (available = true) => fixtureProduct({
  id: 9001,
  title: "Egerie Curved Headboard Beige Boucle Bed",
  productType: "Bed",
  options: { Size: ["Double", "King", "Super King"], Fabric: ["Beige Boucle"] },
  price: (options) => options.Size === "Double" ? 699 : options.Size === "King" ? 799 : 899,
  available: () => available,
  tags: ["boucle", "curved headboard"],
});
const sofas = [
  fixtureProduct({ id: 9101, title: "Milan Corner Sofa", productType: "Sofa", options: { Colour: ["Grey"] }, price: 1299 }),
  fixtureProduct({ id: 9102, title: "Oslo Two Seater", productType: "Sofa", options: { Colour: ["Green"] }, price: 899 }),
];

const ask = (admin: ReturnType<typeof fixtureAdmin>, client: any, content: string, extra: Record<string, unknown> = {}) =>
  answerRoomAssistant({ admin, shopId: SHOP, history: [{ role: "user", content }], client, env: {} as any, settings, ...extra });

const search = (args: Record<string, unknown>) => toolCall("search_products", {
  query: "bed", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: false, limit: 6, ...args,
});

const FALSE_CLAIM = "This store currently does not have any beds available for sale.";

beforeEach(() => {
  resetAssistantCatalogueCache();
  resetAssistantKnowledgeCache();
  state.configs = [];
  logs.length = 0;
  setAssistantLogSink((line) => logs.push(JSON.parse(line)));
});

describe("Shopify query cost budget", () => {
  it("keeps every assistant query well under Shopify's single-query limit", () => {
    const costs = {
      catalogue: requestedQueryCost(CATALOGUE_QUERY, { after: null, query: "status:active" }),
      detail: requestedQueryCost(PRODUCT_DETAIL_QUERY),
      count: requestedQueryCost(PRODUCT_COUNT_QUERY),
      storeInfo: requestedQueryCost(STORE_INFO_QUERY),
      pages: requestedQueryCost(STORE_PAGES_QUERY),
      previewProduct: requestedQueryCost(PREVIEW_PRODUCT_QUERY),
    };
    for (const [name, cost] of Object.entries(costs)) expect(cost, name).toBeLessThanOrEqual(SHOPIFY_MAX_QUERY_COST * 0.8);
  });

  it("would have caught the production query: 20 products × 20 variants with images is rejected", async () => {
    const previous = CATALOGUE_QUERY
      .replace(/products\(first: \d+/, "products(first: 20")
      .replace(/variants\(first: \d+\) \{ nodes \{ /, "variants(first: 20) { nodes { image { url(transform: { maxWidth: 800, maxHeight: 800 }) } ");
    expect(requestedQueryCost(previous)).toBeGreaterThan(SHOPIFY_MAX_QUERY_COST);
    const admin = fixtureAdmin([egerie()]);
    const response = await admin.graphql(previous, { variables: { after: null, query: "status:active" } });
    expect((await response.json()).errors[0].extensions.code).toBe("MAX_COST_EXCEEDED");
  });

  it("loads a real-sized catalogue through the fixed query without exceeding the limit", async () => {
    const admin = fixtureAdmin([egerie(), ...sofas, ...furnitureCatalogue(200)]);
    const { snapshot } = await getCatalogue(admin, SHOP, 10_000);
    expect(snapshot!.products).toHaveLength(203);
    expect(snapshot!.complete).toBe(true);
    expect(snapshot!.byRef.get("9001")!.title).toBe("Egerie Curved Headboard Beige Boucle Bed");
    expect(logs.some((line) => line.event === "shopify_failure")).toBe(false);
    expect(MAX_INDEXED_PRODUCTS).toBeGreaterThanOrEqual(500);
  });
});

describe("the Egerie incident", () => {
  it("finds the Egerie bed when the shopper asks about beds on its product page", async () => {
    const admin = fixtureAdmin([egerie(), ...sofas]);
    const { client, requests } = scriptedModel([search({ query: "bed" }), finalAnswer("Yes, the Egerie bed is available.")]);
    await ask(admin, client, "Do you have any beds?", { currentProductId: "gid://shopify/Product/9001" });
    const developer = requests[0].input.find((item: any) => item.role === "developer").content;
    expect(developer).toContain('viewing a product this store sells (verified from Shopify): productRef 9001, "Egerie Curved Headboard Beige Boucle Bed" (Bed;');
    expect(developer).toContain("3 of 3 variants available to buy");
    const [output] = toolOutputs(requests, "call-search_products");
    expect(output.results.map((result: any) => result.title)).toEqual(["Egerie Curved Headboard Beige Boucle Bed"]);
    expect(output.catalogue.complete).toBe(true);
  });

  it("never tells the shopper there are no beds when Shopify rejects the catalogue query", async () => {
    // Reproduces production: catalogue and live search fail with MAX_COST_EXCEEDED; product detail still works.
    const admin = fixtureAdmin([egerie(), ...sofas], {}, { fail: (name) => name === "TryoraAssistantCatalogue", failCode: "MAX_COST_EXCEEDED" });
    const { client, requests } = scriptedModel([search({ query: "bed", availableOnly: true }), finalAnswer(`${FALSE_CLAIM} Is there anything else I can help with?`)]);
    const reply = await ask(admin, client, "Do you have beds?", { currentProductId: "gid://shopify/Product/9001" });
    // The product page itself is verified context and is still searchable.
    const [output] = toolOutputs(requests, "call-search_products");
    expect(output.results.map((result: any) => result.productRef)).toEqual(["9001"]);
    expect(output.catalogue).toMatchObject({ complete: false, coverage: "catalogue unavailable; only the product the shopper is viewing was checked" });
    // A false absence claim never reaches the shopper.
    expect(reply.message).not.toMatch(/does not have any beds/i);
    expect(reply.message).toContain("I couldn't verify the store's full range just now, so I can't say it has none. You're viewing the Egerie Curved Headboard Beige Boucle Bed, which this store sells.");
    expect(reply.message).toContain("Is there anything else I can help with?");
    expect(logs).toContainEqual(expect.objectContaining({ event: "shopify_failure", stage: "catalogue_page", code: "MAX_COST_EXCEEDED" }));
    expect(logs).toContainEqual(expect.objectContaining({ event: "model_parse_failure", reason: "unverified_absence_claim_removed" }));
  });

  it("reports a sold-out bed as sold by the store, not as missing", async () => {
    const admin = fixtureAdmin([egerie(false), ...sofas]);
    const { client, requests } = scriptedModel([search({ query: "bed", availableOnly: true }), finalAnswer("The Egerie bed is currently sold out.")]);
    await ask(admin, client, "Any beds in stock?");
    const [output] = toolOutputs(requests, "call-search_products");
    expect(output.results).toEqual([]);
    expect(output.relatedProducts.map((result: any) => result.title)).toEqual(["Egerie Curved Headboard Beige Boucle Bed"]);
    expect(output.relatedProducts[0].availability).toBe("sold out");
    expect(output.note).toMatch(/The store does sell them/);
  });

  it("says nothing matched without claiming absence when the catalogue is incomplete", async () => {
    const admin = fixtureAdmin([...sofas], {}, { fail: (name) => name === "TryoraAssistantCatalogue" });
    const { client, requests } = scriptedModel([search({ query: "bed" }), finalAnswer("We don't have any beds.")]);
    const reply = await ask(admin, client, "Beds?");
    expect(toolOutputs(requests, "call-search_products")[0]).toMatchObject({ error: "store_data_temporarily_unavailable" });
    expect(reply.message).toBe("I couldn't verify the store's full range just now, so I can't say it has none.");
  });

  it("corrects itself across turns when the shopper points to the bed they are viewing", async () => {
    const admin = fixtureAdmin([egerie(), ...sofas]);
    const { client, requests } = scriptedModel([
      toolCall("get_product_details", { productRefs: ["9001"], colour: null, size: null, material: null }),
      finalAnswer("You're right, the Egerie bed comes in Double, King and Super King."),
    ]);
    const reply = await answerRoomAssistant({
      admin, shopId: SHOP, client, env: {} as any, settings, currentProductId: "gid://shopify/Product/9001",
      history: [
        { role: "user", content: "Do you have beds?" },
        { role: "assistant", content: FALSE_CLAIM },
        { role: "user", content: "But I'm looking at the Egerie bed right now?" },
      ],
    });
    const developer = requests[0].input.find((item: any) => item.role === "developer").content;
    expect(developer).toContain("Egerie Curved Headboard Beige Boucle Bed");
    expect(requests[0].instructions).toMatch(/The product the shopper is viewing is sold by this store/);
    expect(toolOutputs(requests, "call-get_product_details")[0].products[0].variants).toHaveLength(3);
    expect(reply.message).toContain("Double, King and Super King");
  });
});

describe("product counts", () => {
  const catalogue = () => [egerie(), ...sofas, ...furnitureCatalogue(60)];
  const beds = () => catalogue().filter((product) => product.productType === "Bed").length;

  it("counts across the complete index, not a capped search page", async () => {
    const admin = fixtureAdmin(catalogue());
    const { client, requests } = scriptedModel([
      toolCall("count_products", { query: "beds", colour: null, material: null }),
      finalAnswer(`We have ${beds()} beds.`),
    ]);
    await ask(admin, client, "How many beds do you sell?");
    const [count] = toolOutputs(requests, "call-count_products");
    expect(count).toMatchObject({ verified: true, count: beds(), basis: expect.stringMatching(/all 63 products/) });
    expect(beds()).toBeGreaterThan(10); // more than any search page would show
    expect(admin.calls.TryoraAssistantCount).toBeUndefined();
  });

  it("uses Shopify's productsCount when the index is not complete", async () => {
    const admin = fixtureAdmin(catalogue(), {}, { fail: (name) => name === "TryoraAssistantCatalogue" });
    const { client, requests } = scriptedModel([toolCall("count_products", { query: "bed", colour: null, material: null }), finalAnswer("Counted.")]);
    await ask(admin, client, "How many beds?");
    expect(toolOutputs(requests, "call-count_products")[0]).toMatchObject({ verified: true, count: beds(), precision: "EXACT", basis: expect.stringMatching(/Shopify count of active products/) });
    expect(admin.calls.TryoraAssistantCount).toBe(1);
  });

  it("refuses to state a number when counting fails", async () => {
    const admin = fixtureAdmin(catalogue(), {}, { fail: (name) => name === "TryoraAssistantCatalogue" || name === "TryoraAssistantCount" });
    const { client, requests } = scriptedModel([toolCall("count_products", { query: "bed", colour: null, material: null }), finalAnswer("I couldn't check that right now.")]);
    await ask(admin, client, "How many beds?");
    expect(toolOutputs(requests, "call-count_products")[0]).toEqual({ verified: false, instruction: expect.stringMatching(/do not state a number/) });
  });

  it("allows an absence statement only after a verified zero", async () => {
    const admin = fixtureAdmin([...sofas]);
    const { client } = scriptedModel([toolCall("count_products", { query: "wardrobe", colour: null, material: null }), finalAnswer("This store doesn't have any wardrobes.")]);
    const reply = await ask(admin, client, "Do you sell wardrobes?");
    expect(reply.message).toBe("This store doesn't have any wardrobes.");
  });
});

describe("absence-claim guard", () => {
  it("replaces unverified 'the store has none' sentences only", () => {
    const cases: [string, boolean][] = [
      ["This store currently does not have any beds available for sale.", true],
      ["We don't have any sofas right now.", true],
      ["There are no beds in stock.", true],
      ["Unfortunately, no beds are available.", true],
      ["The store has no wardrobes.", true],
      ["There is no delivery charge on orders over £500.", false],
      ["Returns are free and there is no restocking fee.", false],
      ["Option 1 has no storage drawers.", false],
      ["The Egerie bed is available in King.", false],
    ];
    for (const [sentence, flagged] of cases) expect(guardAbsenceClaims(sentence, null).replaced, sentence).toBe(flagged ? 1 : 0);
    expect(guardAbsenceClaims("Hi! We don't have any beds. Anything else?", { title: "Egerie Bed" }).message)
      .toBe("Hi! I couldn't verify the store's full range just now, so I can't say it has none. You're viewing the Egerie Bed, which this store sells. Anything else?");
  });
});

describe("merchant catalogue diagnostics", () => {
  it("shows what the assistant can see in a healthy store, including the viewed product", async () => {
    const admin = fixtureAdmin([egerie(), ...sofas, fixtureProduct({ id: 9201, title: "Hidden Bed", productType: "Bed", options: { Size: ["King"] }, published: false })]);
    const report = await runAssistantDiagnostics(admin, SHOP, { search: "bed", handle: egerie().handle });
    expect(report.shop).toBe(SHOP);
    expect(report.checks.scopes).toMatchObject({ ok: true, detail: expect.stringMatching(/write_products/) });
    expect(report.checks.counts).toMatchObject({ ok: true, detail: "4 active of 4 products (EXACT)." });
    expect(report.checks.catalogue).toMatchObject({ ok: true, detail: expect.stringMatching(/4 active products; 3 are published/) });
    expect(report.checks.search).toMatchObject({ ok: true, detail: expect.stringMatching(/Egerie Curved Headboard Beige Boucle Bed/) });
    expect(report.checks.product).toMatchObject({ ok: true, detail: expect.stringMatching(/status ACTIVE, published to the Online Store, type "Bed", 3 variants \(3 of the first 3 available to buy\)/) });
  });

  it("surfaces the exact Shopify error when the catalogue query is rejected", async () => {
    const admin = fixtureAdmin([egerie()], {}, { fail: (name) => name === "TryoraAssistantCatalogue", failCode: "MAX_COST_EXCEEDED" });
    const report = await runAssistantDiagnostics(admin, SHOP, { search: "bed", handle: "" });
    expect(report.checks.catalogue).toMatchObject({ ok: false, code: "MAX_COST_EXCEEDED", detail: expect.stringMatching(/cannot see products/) });
    expect(report.checks.search).toMatchObject({ ok: false });
    expect(report.checks.counts.ok).toBe(true);
  });
});
