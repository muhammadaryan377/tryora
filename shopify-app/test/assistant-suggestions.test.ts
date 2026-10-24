import { beforeEach, describe, expect, it } from "vitest";
import { catalogueWelcome, loadCatalogueWelcome } from "../app/assistant/suggestions.server";
import { parseProduct, snapshotFrom, resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { fixtureAdmin, fixtureProduct, type FixtureProduct } from "./fixtures/assistant-store";

const shop = "beds.myshopify.com";
const bed = fixtureProduct({ id: 1, title: "Aria Bed", productType: "Bed", options: { Colour: ["Cream", "Grey"], Size: ["King"] }, available: (o) => o.Colour !== "Grey" });
const other = fixtureProduct({ id: 2, title: "Aspen Bed", productType: "Bed", options: { "2. Choose Your Fabric": ["Velvet"], Size: ["Double"] } });
const snapshot = (products: FixtureProduct[], tenant = shop) => snapshotFrom(tenant, products.map((p) => parseProduct(p, p.variants, true)!).filter(Boolean), true);
beforeEach(() => resetAssistantCatalogueCache());

describe("catalogue-grounded previewer welcome without question chips", () => {
  it("grounds the recommendation card in native catalogue data and returns no suggested questions", () => {
    const result = catalogueWelcome(snapshot([bed, other]), shop, bed.id);
    expect(result).toEqual({ suggestions: [], recommendation: { noun: "bed", fabric: true, colour: true } });
    expect(result).not.toHaveProperty("previewAvailable");
  });
  it("uses each merchant's own category and rejects cross-tenant snapshots", () => {
    const sofa = fixtureProduct({ title: "Oslo Sofa", productType: "Sofa", options: { Fabric: ["Boucle"] } });
    expect(catalogueWelcome(snapshot([sofa], "sofas.myshopify.com"), "sofas.myshopify.com"))
      .toEqual({ suggestions: [], recommendation: { noun: "sofa", fabric: true, colour: false } });
    expect(catalogueWelcome(snapshot([bed]), "other.myshopify.com")).toEqual({ suggestions: [], recommendation: null });
  });
  it("uses the current product category rather than an unrelated majority category", () => {
    const sofa = fixtureProduct({ title: "Oslo Sofa", productType: "Sofa", options: { Title: ["Default Title"] } });
    expect(catalogueWelcome(snapshot([bed, other, sofa]), shop, sofa.id))
      .toEqual({ suggestions: [], recommendation: { noun: "sofa", fabric: false, colour: false } });
  });
  it.each(["Bedside Table", "constructor", "toString"])("uses neutral wording for the custom category %s", (productType) => {
    const table = fixtureProduct({ title: "Oak Bedside Table", productType, options: { Title: ["Default Title"] } });
    expect(catalogueWelcome(snapshot([table]), shop, "missing"))
      .toEqual({ suggestions: [], recommendation: { noun: "furniture", fabric: false, colour: false } });
  });
  it("ignores sold-out/unpublished data and keeps external/composite appearance labels opaque", () => {
    const sold = fixtureProduct({ title: "Sold Sofa", productType: "Sofa", options: { Colour: ["Green"] }, available: () => false });
    const hidden = fixtureProduct({ title: "Hidden Bed", productType: "Bed", options: { Colour: ["Blue"] }, published: false });
    const composite = fixtureProduct({ title: "Composite Bed", productType: "Bed", options: { "Other bed choices": ["Velvet: Ruby | Storage: None"] } });
    expect(catalogueWelcome(snapshot([sold, hidden, composite]), shop))
      .toEqual({ suggestions: [], recommendation: { noun: "bed", fabric: false, colour: false } });
  });
  it("has no fabricated defaults for empty or inaccessible catalogues", async () => {
    const empty = { suggestions: [], recommendation: null };
    expect(catalogueWelcome(null, shop)).toEqual(empty);
    expect(catalogueWelcome(snapshot([]), shop)).toEqual(empty);
    expect(await loadCatalogueWelcome({ graphql: async () => { throw new Error("unavailable"); } }, shop)).toEqual(empty);
  });
  it("reuses the bounded cached catalogue without an AI or credit call", async () => {
    const admin = fixtureAdmin([bed, other]);
    const result = await loadCatalogueWelcome(admin, shop, "1");
    expect(result).toEqual({ suggestions: [], recommendation: { noun: "bed", fabric: true, colour: true } });
    const calls = { ...admin.calls };
    expect(await loadCatalogueWelcome(admin, shop, "1")).toEqual(result);
    expect(admin.calls).toEqual(calls);
  });
});
