import { describe, expect, it } from "vitest";
import { emptyState, historyFor, type Recommendation } from "../../packages/storefront/src/assistant/session";

describe("completed preview conversation context", () => {
  it("keeps the latest consecutive shopper question within the request size limit", () => {
    const state = emptyState("demo.myshopify.com");
    state.entries = [
      { id: "old", kind: "user", text: "a".repeat(800), photo: false, at: 1 },
      { id: "latest", kind: "user", text: "b".repeat(800), photo: false, at: 2 },
    ];
    expect(historyFor(state, "latest")).toEqual([{ role: "user", content: "b".repeat(800) }]);
  });
  it("keeps the previous answer and ordered product cards, including card-only replies", () => {
    const state = emptyState("demo.myshopify.com");
    const item = (title: string, productRef: string): Recommendation => ({
      id: `${productRef}:11`, title, productRef, variantRef: "11", productId: `gid://shopify/Product/${productRef}`,
      variantId: "gid://shopify/ProductVariant/11", options: { Colour: "Cream" }, url: "/products/bed",
      image: null, price: "500", maxPrice: null, currencyCode: "GBP", purchaseAvailable: true,
      previewAvailable: true, previewStatus: "available", optionValue: "Cream", reason: "Suits the room.",
    });
    state.entries = [
      { id: "u1", kind: "user", text: "Show me beds", photo: false, at: 1 },
      { id: "a1", kind: "assistant", replyTo: "u1", text: "These suit your room.", status: "done", recommendations: [item("Aspen Bed", "1"), item("Hampton Bed", "2")], visualise: null, at: 2 },
      { id: "a2", kind: "assistant", replyTo: "u1", text: "", status: "done", recommendations: [item("Aria Bed", "3")], visualise: null, at: 3 },
      { id: "u2", kind: "user", text: "Tell me about the second bed you showed", photo: false, at: 4 },
    ];
    const history = historyFor(state, "u2");
    expect(history.at(-2)?.content).toContain("These suit your room.");
    expect(history.at(-2)?.content).toContain('"option":2,"title":"Hampton Bed"');
    expect(history.at(-2)?.content).toContain("Aria Bed");
    expect(history.at(-2)?.content).toContain('"Colour":"Cream"');
    expect(history.at(-1)?.content).toBe("Tell me about the second bed you showed");
  });
  it("informs the assistant that a preview was delivered before positive feedback", () => {
    const state = emptyState("demo.myshopify.com");
    const item = { title: "Chelsea Luxe Bed", productRef: "101", variantRef: "202" } as Recommendation;
    state.entries = [
      { id: "u1", kind: "user", text: "Show this bed in my room", photo: true, at: 1 },
      { id: "a1", kind: "assistant", replyTo: "u1", text: "Here is the preview option.", status: "done", recommendations: [], visualise: null, at: 2 },
      { id: "p1", kind: "preview", item, status: "ready", at: 3 },
      { id: "u2", kind: "user", text: "ok ye acha laga", photo: false, at: 4 },
    ];
    const history = historyFor(state, "u2");
    expect(history.at(-2)?.role).toBe("assistant");
    expect(history.at(-2)?.content).toContain("AI room preview already generated and shown for Chelsea Luxe Bed");
    expect(history.at(-1)).toEqual({ role: "user", content: "ok ye acha laga" });
    expect(JSON.stringify(history)).not.toContain("blob:");
  });
});
