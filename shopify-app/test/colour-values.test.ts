import { describe, expect, it } from "vitest";
import { hexToRgb, rgbToHex } from "../app/customization/colour-values";
describe("merchant colour representations", () => {
 it("keeps HEX and RGB consistent including endpoints", () => {
  expect(hexToRgb("#F5EEDD")).toBe("245, 238, 221"); expect(rgbToHex("245, 238, 221")).toBe("#f5eedd");
  expect(rgbToHex("0, 0, 0")).toBe("#000000"); expect(rgbToHex("255,255,255")).toBe("#ffffff");
 });
 it("does not fabricate absent or invalid colours", () => {
  expect(hexToRgb(null)).toBe(""); expect(hexToRgb("Ascot")).toBe("");
  for (const invalid of ["256, 1, 2", "-1, 0, 0", "1.5, 2, 3", "red", "1, 2", "", "1e2, 2, 3"]) expect(rgbToHex(invalid)).toBeNull();
 });
});
