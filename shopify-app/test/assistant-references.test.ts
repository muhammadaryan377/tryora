/** Deterministic reference resolution and constraints, using the titles and messages from the test-store screenshots. */
import { describe, expect, it } from "vitest";
import {
  childrenIntent,
  EMPTY_CONSTRAINTS,
  isChildrensProduct,
  namedProduct,
  nextConstraints,
  parseBudget,
  resolveReference,
  type Candidate,
} from "../app/assistant/references.server";

const EGERIE: Candidate = { productRef: "101", title: "Egerie Curved Headboard Beige Boucle Bed", minPrice: 319.99, children: false };
const CLOUD: Candidate = { productRef: "102", title: "Cloud Nine Upholstered kids", minPrice: 239.99, children: true };
const CAMDEN: Candidate = { productRef: "103", title: "Camden Bed", minPrice: 359.99, children: false };
const PINK: Candidate = { productRef: "104", title: "Pink Kids Bed Modern 2026", minPrice: 239.99, children: true };
const candidates = [EGERIE, CLOUD, CAMDEN, PINK];
const shown = ["101", "102", "103"];
const resolve = (message: string, extra: Partial<Parameters<typeof resolveReference>[1]> = {}) =>
  resolveReference(message, { shown, selected: null, constraints: EMPTY_CONSTRAINTS, candidates, ...extra });

describe("budget", () => {
  it("reads the ways shoppers state a budget", () => {
    expect(parseBudget("my budget 250$")).toEqual({ budgetMax: 250, budgetMin: null, budgetCurrency: "$" });
    expect(parseBudget("My budget is $250")).toEqual({ budgetMax: 250, budgetMin: null, budgetCurrency: "$" });
    expect(parseBudget("something under £400 please")).toEqual({ budgetMax: 400, budgetMin: null, budgetCurrency: "£" });
    expect(parseBudget("max 300")).toEqual({ budgetMax: 300, budgetMin: null, budgetCurrency: null });
    expect(parseBudget("between 200 and 450 dollars")).toEqual({ budgetMin: 200, budgetMax: 450, budgetCurrency: "$" });
    expect(parseBudget("budget of 1,200")).toEqual({ budgetMax: 1200, budgetMin: null, budgetCurrency: null });
    expect(parseBudget("no budget, show me the best")).toBe("cleared");
    expect(parseBudget("I have 2 kids")).toBeNull();
    expect(parseBudget("the 3rd one")).toBeNull();
  });

  it("persists the latest budget across turns until the shopper changes it", () => {
    let state = nextConstraints(null, "my budget 250$");
    state = nextConstraints(state, "show me grey ones");
    expect(state).toMatchObject({ budgetMax: 250, budgetCurrency: "$" });
    state = nextConstraints(state, "actually up to 400");
    expect(state.budgetMax).toBe(400);
    expect(nextConstraints(state, "forget my budget").budgetMax).toBeNull();
  });
});

describe("audience", () => {
  it("only treats children's furniture as relevant when the shopper says so", () => {
    expect(childrenIntent("plz suggest some beds according to my room")).toBeNull();
    expect(childrenIntent("it's for my daughter's room")).toBe(true);
    expect(childrenIntent("not for kids, it's our bedroom")).toBe(false);
    expect(nextConstraints(null, "my budget 250$").forChildren).toBe(false);
    expect(isChildrensProduct({ title: "Cloud Nine Upholstered kids" })).toBe(true);
    expect(isChildrensProduct({ title: "Starry Bed", productType: "Bed", collections: [{ title: "Children's Beds" }] })).toBe(true);
    expect(isChildrensProduct({ title: "Egerie Curved Headboard Beige Boucle Bed" })).toBe(false);
  });
});

describe("product references", () => {
  it("recognises products named in the message, including truncated names", () => {
    expect(namedProduct("i said show me Cloud Nine U", candidates)).toBe("102");
    expect(namedProduct("Show me Cloud Nine", candidates)).toBe("102");
    expect(namedProduct("what about egerie in cream", candidates)).toBe("101");
    expect(namedProduct("the pink one", candidates)).toBe("104");
    expect(namedProduct("show me a bed", candidates)).toBeNull();
    expect(namedProduct("show me the bed in my room", candidates)).toBeNull();
    // A real name beats colour-only titles that happen to share a word with the message.
    const aria: Candidate = { productRef: "1", title: "Aria Upholstered Bed", minPrice: 899, children: false };
    const creamBed: Candidate = { productRef: "9", title: "Cream Velvet Bed", minPrice: 499, children: false };
    expect(namedProduct("Show the Aria in cream in my room", [aria, creamBed, ...candidates])).toBe("1");
    expect(namedProduct("the cream one", [aria, creamBed])).toBe("9");
  });

  it("Scenario A: a card selection is authoritative for 'this one'", () => {
    const selected = { productRef: "102", variantRef: "1021", source: "card" as const };
    expect(resolve("I like this one", { selected })).toEqual({ kind: "selected", productRef: "102", variantRef: "1021", source: "card" });
    expect(resolve("show it in my room", { selected })).toMatchObject({ kind: "selected", productRef: "102" });
    // A card selection stays explicit even when it is over budget.
    expect(resolve("show that", { selected, constraints: { ...EMPTY_CONSTRAINTS, budgetMax: 100 } })).toMatchObject({ kind: "selected", productRef: "102" });
  });

  it("'select one' asks the assistant to choose (among products that fit), never a silent default", () => {
    expect(resolve("select one")).toEqual({ kind: "choose_for_me" });
    expect(resolve("i want you to select one")).toEqual({ kind: "choose_for_me" });
    // Scenario A: right after choosing Option 2 on its card, "select one" confirms that card instead of swapping it.
    const card = { productRef: "102", variantRef: "1021", source: "card" as const };
    expect(resolve("select one", { selected: card })).toEqual({ kind: "selected", ...card });
    expect(resolve("you choose a different one", { selected: card })).toEqual({ kind: "choose_for_me" });
    // A selection the assistant made earlier does not count as the shopper's choice.
    expect(resolve("select one", { selected: { ...card, source: "conversation" } })).toEqual({ kind: "choose_for_me" });
  });

  it("resolves ordinal references to the latest recommendations, in order", () => {
    expect(resolve("Show me the second one")).toEqual({ kind: "ordinal", productRef: "102", position: 2 });
    expect(resolve("option 3 please")).toEqual({ kind: "ordinal", productRef: "103", position: 3 });
    expect(resolve("the last one")).toEqual({ kind: "ordinal", productRef: "103", position: 3 });
    // The latest message beats an older selection.
    expect(resolve("the second one", { selected: { productRef: "101", variantRef: null, source: "conversation" } })).toMatchObject({ productRef: "102" });
  });

  it("Scenario C: an ambiguous 'show me tha' never revives an over-budget conversation selection", () => {
    const selected = { productRef: "101", variantRef: null, source: "conversation" as const };
    const result = resolve("show me tha", { selected, shown: ["102", "104"], constraints: { ...EMPTY_CONSTRAINTS, budgetMax: 250 } });
    expect(result).toEqual({ kind: "ambiguous", candidates: ["102", "104"], reason: "selection_conflicts_with_constraints" });
    // With several recent products and no selection, it is ambiguous too.
    expect(resolve("show me that")).toEqual({ kind: "ambiguous", candidates: shown, reason: "several_recent" });
    // A single recent product is unambiguous.
    expect(resolve("show me that", { shown: ["103"] })).toEqual({ kind: "ordinal", productRef: "103", position: 1 });
  });

  it("an explicitly named product overrides any selection", () => {
    const selected = { productRef: "101", variantRef: null, source: "card" as const };
    expect(resolve("Show me Cloud Nine", { selected })).toEqual({ kind: "named", productRef: "102" });
  });

  it("messages that are not about a product do not resolve to the old selection", () => {
    const selected = { productRef: "101", variantRef: null, source: "conversation" as const };
    expect(resolve("my budget 250$", { selected })).toEqual({ kind: "none" });
    expect(resolve("what is your returns policy", { selected })).toEqual({ kind: "none" });
  });
});
