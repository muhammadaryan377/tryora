import { describe, expect, it } from "vitest";
import { guessColour, resolveSwatches } from "../src/colourGuess.js";

describe("guessColour", () => {
  it("finds plain and fabric colour names", () => {
    expect(guessColour("Red")).toBe("#b3261e");
    expect(guessColour("Navy")).toBe("#24345a");
    expect(guessColour("Oatmeal Boucle")).toBe("#d6c6ad");
  });
  it("uses the last colour word and light/dark modifiers", () => {
    expect(guessColour("Dusky Rose Velvet")).toBe("#c9a39a");
    expect(guessColour("Dark Grey")).not.toBe(guessColour("Grey"));
    expect(guessColour("Light Grey")).not.toBe(guessColour("Grey"));
    expect(guessColour("Gray")).toBe(guessColour("Grey"));
    expect(guessColour("Off-white")).toBe(guessColour("Ivory"));
  });
  it("returns null when no colour word is present", () => {
    expect(guessColour("Harbour")).toBeNull();
    expect(guessColour("Style 3")).toBeNull();
  });
});

describe("resolveSwatches", () => {
  const values = [
    { value: "Oat", shopifyColour: "#ddccbb" },
    { value: "Navy" },
    { value: "Harbour" },
    { value: "Olive" },
  ];
  it("prefers Shopify, then merchant colours, and never guesses without approval", () => {
    const r = resolveSwatches(values, { Olive: "#556b2f" }, false);
    expect(r.map((s) => s.source)).toEqual(["shopify", "missing", "missing", "merchant"]);
  });
  it("guesses only names it recognises once approved", () => {
    const r = resolveSwatches(values, {}, true);
    expect(r.map((s) => s.source)).toEqual(["shopify", "guess", "missing", "guess"]);
  });
});
