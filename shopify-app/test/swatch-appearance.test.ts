import { describe, expect, it } from "vitest";
import { swatchAppearanceStyle } from "../../packages/storefront/src/swatch-appearance";

describe("shopper swatch sizing", () => {
  it("renders circle and rectangle dimensions", () => {
    expect(swatchAppearanceStyle({ shape: "circle", size: 25 })).toContain("width:25px;height:25px;border-radius:50%");
    expect(swatchAppearanceStyle({ shape: "rectangle", size: 100 })).toContain("width:100px;height:70px;border-radius:5px");
  });
  it.each([null, undefined, {}, { shape: "circle", size: "50;display:none" }, { shape: "square", size: 50 }, { shape: "circle", size: 999 }])("preserves legacy CSS for invalid/missing settings %j", (value) => {
    expect(swatchAppearanceStyle(value)).toBe("");
  });
});
