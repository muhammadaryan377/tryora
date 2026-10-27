import { describe, expect, it } from "vitest";
import { planShopperTurn } from "../app/assistant/intent.server";
import { mergeShopperPreferences, recommendationIntro, simpleSocialReply, type ShopperPreferences, type RoomObservations } from "../app/room-assistant.server";

const intent = (latest: string, previousUserMessages = ["Show me sofas"]) => planShopperTurn({
  latest, previousUserMessages, roomKnown: true, newRoomPhoto: false,
  selectedProductName: "Aria Sofa",
});

describe("natural English conversation understanding", () => {
  it("responds to simple greetings and reactions without inventing product claims", () => {
    expect(simpleSocialReply("Hi!")).toContain("What are you looking for?");
    expect(simpleSocialReply("Thanks")).toBe("You're welcome!");
    expect(simpleSocialReply("Looks great!")).toBe("Glad you like it!");
    expect(simpleSocialReply("What is the delivery price?")).toBeNull();
    expect(simpleSocialReply("I like the second one")).toBeNull();
  });


  it("treats which one is cheaper as a comparison, not a new catalogue search", () => {
    expect(intent("Which one is cheaper?").intent).toBe("comparison");
    expect(intent("Which one is better?").intent).toBe("comparison");
    expect(intent("Which is the cheapest?").intent).toBe("comparison");
  });

  it("understands a contextual colour follow-up without forgetting the previous category", () => {
    const planned = intent("What about grey?");
    expect(planned.intent).toBe("product_question");
    expect(planned.inheritedCategory).toBe("sofa");
    expect(planned.standaloneQuery).toContain("Answer the actual question first");
  });

  it("recognises customer reactions and does not push an old preview again", () => {
    expect(intent("I like it").intent).toBe("acknowledgement");
    expect(intent("Looks great!").intent).toBe("acknowledgement");
  });

  it("separates why-only-two questions from requests for more products", () => {
    expect(intent("Why did you show only two?").intent).toBe("product_question");
    expect(intent("Show me moes").intent).toBe("more_options");
  });
});

const prefs: ShopperPreferences = {
  budgetMin: null, budgetMax: 500, colours: ["grey"], materials: ["velvet"],
  sizes: ["king"], furniture: ["bed"], roomDimensions: "4m x 3m", roomNotes: "Small window",
};
const empty: ShopperPreferences = {
  budgetMin: null, budgetMax: null, colours: [], materials: [], sizes: [],
  furniture: [], roomDimensions: "", roomNotes: "",
};

describe("conversation memory", () => {
  it("does not erase earlier size, fabric or budget when a new colour is mentioned", () => {
    expect(mergeShopperPreferences(prefs, { ...empty, colours: ["sage"] }, "How about sage?")).toMatchObject({
      budgetMax: 500, colours: ["sage"], materials: ["velvet"], sizes: ["king"],
      furniture: ["bed"], roomDimensions: "4m x 3m", roomNotes: "Small window",
    });
  });

  it("allows explicit colour and budget removal", () => {
    expect(mergeShopperPreferences(prefs, empty, "no colour preference").colours).toEqual([]);
    expect(mergeShopperPreferences(prefs, empty, "forget my budget").budgetMax).toBeNull();
  });

  it("combines new room details instead of throwing away an earlier detail", () => {
    expect(mergeShopperPreferences(prefs, { ...empty, roomNotes: "Cream walls" }, "It has cream walls").roomNotes)
      .toBe("Small window; Cream walls");
  });
});

describe("grounded English reply introductions", () => {
  const room = {
    colours: ["cream"], style: "Contemporary", lighting: "warm", notes: "",
    walls: "", floor: "", furniture: [], layout: "", placement: [],
  } satisfies RoomObservations;

  it("uses actual saved room observations for a more relevant introduction", () => {
    expect(recommendationIntro(2, "recommend furniture", room))
      .toBe("With the cream tones in your room, here are 2 options to consider.");
  });

  it("falls back to safe neutral copy when room observations are unavailable", () => {
    expect(recommendationIntro(1, "show beds", null)).toBe("Here is one option to consider.");
  });
});
