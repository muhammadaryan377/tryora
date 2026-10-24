import { describe, expect, it } from "vitest";
import { discoverNativeOptions, nativeOptionRole } from "../src/native-option-discovery";
import { nativeSelections } from "../src/customization";

describe("bounded native option discovery", () => {
  it.each([
    [" Select Your Upholstery-Fabric: ", "fabric"], ["FABRIC_TYPE", "fabric"],
    ["Choose Fabric Color", "colour"], ["Upholstery Colour", "colour"], ["Wood Finish", "finish"],
    ["2. Choose Your Fabric", "fabric"], ["3) Choose Your Colour", "colour"],
    ["2. Fabric care", null], ["Other bed choices", null], ["Material", null], ["Colour surcharge", null], ["Fabric care", null], ["Size", null], ["Shade", null],
  ])("classifies %s without substring guesses", (name, expected) => expect(nativeOptionRole(name!)).toBe(expected));

  it("is independent of option order and retains original Shopify names", () => {
    const options = [{ name: "Upholstery Fabric" }, { name: "Choose Fabric Color" }];
    expect(discoverNativeOptions(options).recommendedName).toBe("Choose Fabric Color");
    expect(discoverNativeOptions([...options].reverse()).recommendedName).toBe("Choose Fabric Color");
  });

  it("does not choose between colliding aliases", () => {
    const found = discoverNativeOptions([{ name: "Colour" }, { name: "Color" }]);
    expect(found.ambiguous).toBe(true);
    expect(found.recommendedName).toBeNull();
  });

  it("uses aliases for real combinations but never repairs stale saved identities", () => {
    const options = [
      { name: "Upholstery Fabric", optionValues: [{ name: "Velvet" }] },
      { name: "Fabric Color", optionValues: [{ name: "Cream" }, { name: "Grey" }] },
    ];
    const variants = [{ id: "cream", availableForSale: true, image: { url: "https://cdn.shopify.com/cream.jpg" },
      selectedOptions: [{ name: "Upholstery Fabric", value: "Velvet" }, { name: "Fabric Color", value: "Cream" }] }];
    const model = nativeSelections(options, "Upholstery Fabric", variants);
    expect(model.selections.map((s) => s.value)).toEqual(['["Velvet","Cream"]']);
    expect(model.fabricOptionName).toBe("Upholstery Fabric");
    expect(nativeSelections(options, "Fabric", variants).issue).toBe("stale_mapping");
    expect(nativeSelections(options, null, variants).selections).toEqual([]);
  });
});
