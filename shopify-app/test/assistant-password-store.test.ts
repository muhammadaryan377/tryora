/**
 * Password-protected Shopify development stores (test-sofa-site.myshopify.com): Shopify returns onlineStoreUrl = null
 * for every product, even published ones, while publishedAt is set. The assistant previously treated a null
 * onlineStoreUrl as "not published" and so saw an empty catalogue. Simulated Admin API; see the live verifier for
 * real-store checks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/db.server", () => ({
  default: {
    appearance: { findFirst: vi.fn(async () => null) },
    productPreviewConfig: { findMany: vi.fn(async () => []) },
    customizationConfig: { findMany: vi.fn(async () => []) },
  },
}));

import { answerRoomAssistant } from "../app/room-assistant.server";
import { getCatalogue, parseProduct, publishedToOnlineStore, resetAssistantCatalogueCache } from "../app/assistant/catalogue.server";
import { runAssistantDiagnostics } from "../app/assistant/diagnostics.server";
import { resetAssistantKnowledgeCache } from "../app/assistant/knowledge.server";
import { setAssistantLogSink } from "../app/assistant/log.server";
import { DEFAULT_ROOM_ASSISTANT_SETTINGS } from "../app/room-assistant-settings";
import { finalAnswer, fixtureAdmin, fixtureProduct, recommend, scriptedModel, toolCall, toolOutputs } from "./fixtures/assistant-store";

const SHOP = "test-sofa-site.myshopify.com";
setAssistantLogSink(() => {});

const BEDS = ["Chelsea Luxe Bed", "Thames Bed Frame", "Egerie Curved Headboard Beige Boucle Bed", "Monaco Panelled Bed"];
const passwordProtectedStore = () => [
  ...BEDS.map((title, index) => fixtureProduct({ id: 8100 + index, title, productType: "Bed", options: { Size: ["Double", "King"] }, price: 500 + index * 100, passwordProtected: true })),
  fixtureProduct({ id: 8190, title: "Draft Prototype Bed", productType: "Bed", options: { Size: ["King"] }, status: "DRAFT", passwordProtected: true }),
  fixtureProduct({ id: 8191, title: "Unpublished Archive Bed", productType: "Bed", options: { Size: ["King"] }, published: false }),
  fixtureProduct({ id: 8192, title: "Coming Soon Bed", productType: "Bed", options: { Size: ["King"] }, passwordProtected: true, publishedAt: "2099-01-01T00:00:00Z" }),
];

beforeEach(() => {
  resetAssistantCatalogueCache();
  resetAssistantKnowledgeCache();
});

describe("Online Store publication", () => {
  it("does not require onlineStoreUrl, and checks publishedAt separately", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(publishedToOnlineStore({ onlineStoreUrl: "https://shop.example/products/a", publishedAt: null }, now)).toBe(true);
    expect(publishedToOnlineStore({ onlineStoreUrl: null, publishedAt: "2026-09-01T10:00:00Z" }, now)).toBe(true);
    expect(publishedToOnlineStore({ onlineStoreUrl: null, publishedAt: "2026-12-01T10:00:00Z" }, now)).toBe(false); // scheduled
    expect(publishedToOnlineStore({ onlineStoreUrl: null, publishedAt: null }, now)).toBe(false);
    expect(publishedToOnlineStore({ onlineStoreUrl: null, publishedAt: "not a date" }, now)).toBe(false);
  });

  it("builds safe relative links from the handle and rejects malformed handles", () => {
    const base = { id: "gid://shopify/Product/1", title: "Bed", status: "ACTIVE", onlineStoreUrl: null, publishedAt: "2026-09-01T10:00:00Z" };
    expect(parseProduct({ ...base, handle: "egerie-curved-headboard-beige-boucle-bed" }, [], true)!.url).toBe("/products/egerie-curved-headboard-beige-boucle-bed");
    expect(parseProduct({ ...base, handle: "lit-tête-de-lit" }, [], true)!.url).toBe("/products/lit-t%C3%AAte-de-lit");
    for (const handle of ["../../admin", "a b", 'x"><script>', "", "https://evil.example"]) expect(parseProduct({ ...base, handle }, [], true), handle).toBeNull();
    // A full onlineStoreUrl (e.g. another domain) is never used as the link.
    expect(parseProduct({ ...base, handle: "bed", onlineStoreUrl: "https://other-domain.example/products/bed" }, [], true)!.url).toBe("/products/bed");
  });
});

describe("password-protected development store", () => {
  it("indexes every published bed even though Shopify returns no onlineStoreUrl", async () => {
    const { snapshot } = await getCatalogue(fixtureAdmin(passwordProtectedStore()), SHOP, 10_000);
    expect(snapshot!.products.map((product) => product.title)).toEqual(BEDS);
    expect(snapshot!.complete).toBe(true);
  });

  it("answers bed questions with all four beds and correct product links", async () => {
    const admin = fixtureAdmin(passwordProtectedStore());
    const { client, requests } = scriptedModel([
      toolCall("count_products", { query: "bed", colour: null, material: null }),
      toolCall("search_products", { query: "bed", colour: null, size: null, material: null, style: null, minPrice: null, maxPrice: null, availableOnly: true, limit: 6 }),
      recommend([{ productRef: "8102", variantRef: null, reason: "Curved boucle headboard." }]),
      finalAnswer("We have 4 beds. Option 1 is the Egerie."),
    ]);
    const reply = await answerRoomAssistant({
      admin, shopId: SHOP, client, env: {} as any, settings: { ...DEFAULT_ROOM_ASSISTANT_SETTINGS, enabled: true },
      history: [{ role: "user", content: "Do you have any beds? How many?" }], currentProductId: "gid://shopify/Product/8102",
    });
    expect(toolOutputs(requests, "call-count_products")[0]).toMatchObject({ verified: true, count: 4 });
    expect(toolOutputs(requests, "call-search_products")[0].results.map((result: any) => result.title).sort()).toEqual([...BEDS].sort());
    expect(requests[0].input.find((item: any) => item.role === "developer").content).toContain('"Egerie Curved Headboard Beige Boucle Bed"');
    expect(reply.recommendations[0]).toMatchObject({ title: "Egerie Curved Headboard Beige Boucle Bed", url: expect.stringMatching(/^\/products\/egerie-curved-headboard-beige-boucle-bed-\d+$/) });
    expect(reply.message).toBe("We have 4 beds. Option 1 is the Egerie.");
  });

  it("explains the missing onlineStoreUrl in the merchant diagnostics", async () => {
    const products = passwordProtectedStore();
    const egerie = products.find((product) => product.title.startsWith("Egerie"))!;
    const report = await runAssistantDiagnostics(fixtureAdmin(products), SHOP, { search: "bed", handle: egerie.handle });
    expect(report.checks.catalogue.detail).toMatch(/6 active products; 4 are published to the Online Store and usable\. 4 have no onlineStoreUrl but a publishedAt date \(expected while the store is password-protected\); they are included\./);
    expect(report.checks.product).toMatchObject({ ok: true, detail: expect.stringMatching(/published to the Online Store at 2026-09-01T10:00:00Z \(no onlineStoreUrl, as on password-protected stores\), link \/products\/egerie/) });
    const scheduled = products.find((product) => product.title === "Coming Soon Bed")!;
    const later = await runAssistantDiagnostics(fixtureAdmin(products), SHOP, { search: "bed", handle: scheduled.handle });
    expect(later.checks.product).toMatchObject({ ok: false, detail: expect.stringMatching(/scheduled for the Online Store at 2099-01-01/) });
  });
});
