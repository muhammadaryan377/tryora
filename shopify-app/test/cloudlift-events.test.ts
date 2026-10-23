import { describe, expect, it } from "vitest";
import { classifyCloudliftOption, nativeSourceVariantId } from "../../packages/storefront/src/cloudlift-events";

describe("Cloudlift documented option events are signals, never authorization", () => {
  const names = new Set(["1. Choose Your Size", "2. Choose Your Fabric", "Other bed choices"]);

  it("accepts exact native option name and value as a sync hint", () => {
    expect(classifyCloudliftOption({ name: "2. Choose Your Fabric", value: "Plush Velvet" }, names))
      .toEqual({ kind: "native", name: "2. Choose Your Fabric", value: "Plush Velvet" });
  });

  it.each([
    null,
    {},
    [],
    { name: "custom:Colour", value: "Cream" },
    { name: "2. Choose Your Fabric", value: ["Plush Velvet"] },
    { name: "Other bed choices", value: "" },
    { name: "Other bed choices", value: "x".repeat(2049) },
  ])("does not treat unknown or invalid event data as verified native variant context (%s)", (payload) => {
    expect(classifyCloudliftOption(payload, names)).toEqual({ kind: "unverified" });
  });
});

describe("source native variant mapping", () => {
  const variants = [
    { id: "gid://shopify/ProductVariant/11", options: { Size: "King", Fabric: "Velvet", "__tryora_mapped_fabric__": "Velvet" } },
    { id: "gid://shopify/ProductVariant/12", options: { Size: "Double", Fabric: "Velvet", "__tryora_mapped_fabric__": "Velvet" } },
  ];

  it("ignores Tryora virtual keys but preserves size and fabric", () => {
    expect(nativeSourceVariantId({ Size: "King", Fabric: "Velvet" }, variants))
      .toBe("gid://shopify/ProductVariant/11");
  });
  it("rejects missing, unknown, or ambiguous variant context", () => {
    expect(nativeSourceVariantId({}, variants)).toBeNull();
    expect(nativeSourceVariantId({ "__unsupported_variant__": "999" }, variants)).toBeNull();
    expect(nativeSourceVariantId({ Size: "King" }, variants)).toBeNull();
    expect(nativeSourceVariantId({ Size: "King", Fabric: "Velvet" }, [...variants, { ...variants[0]!, id: "duplicate" }])).toBeNull();
  });
});
