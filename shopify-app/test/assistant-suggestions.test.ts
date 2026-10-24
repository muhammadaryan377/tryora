import { beforeEach, describe, expect, it } from "vitest";
import { catalogueSuggestions, loadCatalogueSuggestions } from "../app/assistant/suggestions.server";
import { parseProduct, snapshotFrom, resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { fixtureAdmin, fixtureProduct, type FixtureProduct } from "./fixtures/assistant-store";

const shop = "beds.myshopify.com";
const bed = fixtureProduct({ id: 1, title: "Aria Bed", productType: "Bed", options: { Colour: ["Cream", "Grey"], Size: ["King"] }, available: (o) => o.Colour !== "Grey" });
const other = fixtureProduct({ id: 2, title: "Aspen Bed", productType: "Bed", options: { "2. Choose Your Fabric": ["Velvet"], Size: ["Double"] } });
const snapshot = (products: FixtureProduct[], tenant = shop) => snapshotFrom(tenant, products.map((p) => parseProduct(p, p.variants, true)!).filter(Boolean), true);
beforeEach(() => resetAssistantCatalogueCache());
describe("merchant-grounded welcome suggestions", () => {
  it("selects four distinct questions from actual catalogue facts, prioritising the current product", () => {
    const result = catalogueSuggestions(snapshot([bed, other]), shop, bed.id);
    expect(result).toEqual(["Tell me about Aria Bed", "Show me bed products", "Show me Cream bed products", "What sizes does Aria Bed come in?"]);
    expect(new Set(result).size).toBe(4);
    expect(result.join()).not.toMatch(/Grey|sofa|returns|best.sell/i);
  });
  it("uses each merchant's own catalogue and rejects cross-tenant snapshots", () => {
    const sofa = fixtureProduct({ title: "Oslo Sofa", productType: "Sofa", options: { Fabric: ["Boucle"] } });
    const result = catalogueSuggestions(snapshot([sofa], "sofas.myshopify.com"), "sofas.myshopify.com");
    expect(result.join()).toContain("Boucle sofa");
    expect(result.join()).not.toMatch(/bed|Aria|Cream/);
    expect(catalogueSuggestions(snapshot([bed]), "other.myshopify.com")).toEqual([]);
  });
  it("hides unavailable, unconfigured external labels and opaque composite colours", () => {
    const sold = fixtureProduct({ title: "Sold Sofa", productType: "Sofa", options: { Colour: ["Green"] }, available: () => false });
    const composite = fixtureProduct({ title: "Composite Bed", productType: "Bed", options: { "Other bed choices": ["Velvet: Ruby | Storage: None"] } });
    const result = catalogueSuggestions(snapshot([sold, composite]), shop);
    expect(result.join()).not.toMatch(/Sold|Green|Ruby|Velvet/);
    expect(result.join()).toContain("Composite Bed");
  });
  it("has no fabricated defaults for empty, inaccessible, or unpublished catalogues", async () => {
    expect(catalogueSuggestions(null, shop)).toEqual([]);
    expect(catalogueSuggestions(snapshot([]), shop)).toEqual([]);
    const unpublished = fixtureProduct({ title: "Hidden Bed", productType: "Bed", options: { Colour: ["Cream"] }, published: false });
    expect(catalogueSuggestions(snapshot([unpublished]), shop)).toEqual([]);
    expect(await loadCatalogueSuggestions({ graphql: async () => { throw new Error("unavailable"); } }, shop)).toEqual([]);
  });
  it("reuses the existing bounded Shopify catalogue loader without a model or credit call", async () => {
    const admin = fixtureAdmin([bed, other]);
    const result = await loadCatalogueSuggestions(admin, shop, "1");
    expect(result).toHaveLength(4);
    expect(result[0]).toBe("Tell me about Aria Bed");
  });
});
