import { describe, expect, it } from "vitest";
import { planShopperTurn } from "../app/assistant/intent.server";
import { rankRoomRecommendations, roomFitScore } from "../app/assistant/room-fit.server";
import type { CatalogueProduct } from "../app/assistant/catalogue.server";
import type { RoomObservations, ShopperPreferences } from "../app/room-assistant.server";

const room: RoomObservations = {
  colours: ["cream", "warm neutral"], style: "modern", lighting: "soft",
  walls: "warm white", floor: "oak", furniture: ["rug"], layout: "", placement: [], notes: "",
};
const preferences: ShopperPreferences = {
  budgetMin: null, budgetMax: 700, colours: ["cream"], materials: ["velvet"],
  sizes: [], furniture: ["sofa"], roomDimensions: "", roomNotes: "",
};
const product = (ref: string, title: string, colour: string, material: string): CatalogueProduct => ({
  ref, id: ref, title, productType: "Sofa", description: `A modern ${material} ${colour} sofa.`,
  tags: ["modern"], options: [{ name: "Colour", values: [colour] }, { name: "Fabric", values: [material] }],
  attributes: {}, collections: [], variants: [],
} as unknown as CatalogueProduct);

describe("shopper intent and standalone-query context", () => {
  it("inherits the prior furniture category only for an elliptical follow-up", () => {
    const result = planShopperTurn({
      latest: "What about grey?", previousUserMessages: ["Show me some sofas"],
      roomKnown: true, newRoomPhoto: false, referencedProductName: "Oslo Sofa",
    });
    expect(result.intent).toBe("product_question");
    expect(result.inheritedCategory).toBe("sofa");
    expect(result.standaloneQuery).toContain("Oslo Sofa");
    expect(result.standaloneQuery).toContain("sofa");
    expect(result.needsRoomFit).toBe(false);
  });
  it("does not force the old category when a shopper explicitly changes subject", () => {
    const result = planShopperTurn({
      latest: "Show me a bed instead", previousUserMessages: ["Show me some sofas"],
      roomKnown: true, newRoomPhoto: false,
    });
    expect(result.inheritedCategory).toBeNull();
    expect(result.standaloneQuery).toContain("bed");
  });
  it("recognises a freshly uploaded room recommendation without reusing earlier photos", () => {
    const result = planShopperTurn({
      latest: "What would look best in this room?", previousUserMessages: ["I need a sofa"],
      roomKnown: true, newRoomPhoto: true,
    });
    expect(result.intent).toBe("room_recommendation");
    expect(result.needsRoomFit).toBe(true);
  });
  it("does not turn acknowledgements or product specifications into repeated recommendation cards", () => {
    const previousUserMessages = ["Recommend two sofas for my room"];
    expect(planShopperTurn({ latest: "Looks good", previousUserMessages, roomKnown: true, newRoomPhoto: false }).intent).toBe("acknowledgement");
    expect(planShopperTurn({ latest: "How much does the second one cost?", previousUserMessages, roomKnown: true, newRoomPhoto: false }).intent).toBe("product_question");
    expect(planShopperTurn({ latest: "Preview the second one in my room", previousUserMessages, roomKnown: true, newRoomPhoto: false }).intent).toBe("preview");
    expect(planShopperTurn({ latest: "Show me more", previousUserMessages, roomKnown: true, newRoomPhoto: false }).intent).toBe("more_options");
  });
  it("never hallucinates room evidence or selected products from an independent question", () => {
    const result = planShopperTurn({
      latest: "Do you ship to Scotland?", previousUserMessages: ["Show me a cream sofa"],
      roomKnown: false, newRoomPhoto: false,
    });
    expect(result.intent).toBe("store_support");
    expect(result.inheritedCategory).toBeNull();
    expect(result.needsRoomFit).toBe(false);
    expect(result.standaloneQuery).not.toContain("Verified product");
  });
});

describe("verified room-fit product order", () => {
  const cream = product("1", "Cream Velvet Sofa", "Cream", "Velvet");
  const grey = product("2", "Charcoal Leather Sofa", "Charcoal", "Leather");
  const byRef = new Map([cream, grey].map(p => [p.ref, p]));
  const greyCard = { productRef: "2", options: { Colour: "Charcoal", Fabric: "Leather" }, previewAvailable: true };
  const creamCard = { productRef: "1", options: { Colour: "Cream", Fabric: "Velvet" }, previewAvailable: false };
  it("places a verified better room/colour/material fit first, even without AI preview", () => {
    const ranked = rankRoomRecommendations([greyCard, creamCard], ref => byRef.get(ref), room, preferences);
    expect(ranked.map(p => p.productRef)).toEqual(["1", "2"]);
    expect(roomFitScore(cream, creamCard, room, preferences)).toBeGreaterThan(roomFitScore(grey, greyCard, room, preferences));
  });
  it("preserves the original order when there are no room observations", () => {
    expect(rankRoomRecommendations([greyCard, creamCard], ref => byRef.get(ref), null, preferences)).toEqual([greyCard, creamCard]);
  });
  it("does not invent fit evidence when product details are unavailable", () => {
    const missing = { productRef: "3", options: {}, previewAvailable: true };
    expect(rankRoomRecommendations([missing, creamCard], ref => byRef.get(ref), room, preferences).map(p => p.productRef)).toEqual(["1", "3"]);
  });
});
