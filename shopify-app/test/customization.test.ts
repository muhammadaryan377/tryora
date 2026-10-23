import { describe, expect, it, vi } from "vitest";
import { nativeSelections, type NativeVariant } from "../app/core/customization";
import { resolvePreviewProduct } from "../app/preview-product.server";

const options = [
  { name: "Fabric", optionValues: [{ name: "Plush Velvet" }, { name: "Teddy Boucle" }] },
  { name: "Colour", optionValues: [{ name: "Cream", swatch: { image: { image: { url: "https://cdn.shopify.com/cream-swatch.jpg" } } } }, { name: "Grey" }] },
  { name: "Size", optionValues: [{ name: "King" }, { name: "Double" }] },
];
function variant(id: string, fabric: string, colour: string, size = "King", image: string | null = id): NativeVariant {
  return { id, availableForSale: true, image: image ? { url: `https://cdn.shopify.com/${image}.jpg` } : null,
    selectedOptions: Object.entries({ Fabric: fabric, Colour: colour, Size: size }).map(([name, value]) => ({ name, value })) };
}
const variants = [variant("plush-cream", "Plush Velvet", "Cream"), variant("plush-grey", "Plush Velvet", "Grey"),
  variant("boucle-cream", "Teddy Boucle", "Cream"), variant("boucle-double", "Teddy Boucle", "Cream", "Double")];
const key = (fabric: string, colour: string) => JSON.stringify([fabric, colour]);
const config = { productId: "product", visualOptionName: "Fabric", referenceMediaId: "generic", frozenContext: {}, choices: [] } as any;
const api = (nodes = variants) => ({ graphql: vi.fn(async () => Response.json({ data: { product: {
  title: "Bed", description: "Upholstered", productType: "Bed", options,
  variants: { nodes, pageInfo: { hasNextPage: false } },
} } })) });

describe("native fabric and colour data", () => {
  it("derives only real combinations, preserving merchant swatches and text fallbacks", () => {
    const model = nativeSelections(options, "Fabric", variants);
    expect(model.fabricOptionName).toBe("Fabric");
    expect(model.optionName).toBe("Colour");
    expect(model.selections.map((s) => s.value)).toEqual([
      key("Plush Velvet", "Cream"), key("Plush Velvet", "Grey"), key("Teddy Boucle", "Cream"),
    ]);
    expect(model.selections[0]?.image).toBe("https://cdn.shopify.com/cream-swatch.jpg");
    expect(model.selections[1]).toMatchObject({ image: null, colour: null, label: "Grey" });
    expect(nativeSelections(options, "Colour", variants).selections).toEqual(model.selections);
  });

  it("does not infer app-provided colours from fabric names or a store-wide catalogue", () => {
    const model = nativeSelections([options[0]!], "Fabric", variants);
    expect(model.fabricOptionName).toBeNull();
    expect(model.optionName).toBe("Fabric");
    expect(model.selections.map((s) => s.label)).toEqual(["Plush Velvet", "Teddy Boucle"]);
    expect(model.selections.every((s) => !s.image && !s.colour)).toBe(true);
    expect(nativeSelections(options, null, variants).selections).toEqual([]);
    const misnamed = { ...options[0]!, name: "Colour" };
    expect(nativeSelections([misnamed], "Colour", []).selectorLabel).toBe("Fabric");
  });

  it("binds generation to the exact fabric, colour, size and product photo", async () => {
    const result = await resolvePreviewProduct(api(), config, key("Teddy Boucle", "Cream"), "boucle-double");
    expect(result.urls).toEqual(["https://cdn.shopify.com/boucle-double.jpg"]);
    expect(result.optionValue).toBe("Teddy Boucle / Cream");
    expect(result.description).toContain('"Size","value":"Double"');
    expect(result.description).toContain('"Fabric","value":"Teddy Boucle"');
  });

  it("rejects fabricated pairs, wrong variants, missing IDs and frozen configuration changes", async () => {
    await expect(resolvePreviewProduct(api(), config, key("Teddy Boucle", "Grey"), "boucle-cream")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolvePreviewProduct(api(), config, key("Plush Velvet", "Cream"), "boucle-cream")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolvePreviewProduct(api(), config, key("Plush Velvet", "Cream"))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolvePreviewProduct(api(), { ...config, frozenContext: { Size: "King" } }, key("Teddy Boucle", "Cream"), "boucle-double")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps merchant fabric restrictions and never uses a fabric-wide approval for another colour", async () => {
    const blocked = { ...config, choices: [{ optionValue: "Teddy Boucle", available: false }] };
    await expect(resolvePreviewProduct(api(), blocked, key("Teddy Boucle", "Cream"), "boucle-cream")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const noPhoto = [variant("boucle-cream", "Teddy Boucle", "Cream", "King", null)];
    const broadApproval = { ...config, choices: [{ optionValue: "Teddy Boucle", available: true, approvedMediaIds: ["generic"] }] };
    await expect(resolvePreviewProduct(api(noPhoto), broadApproval, key("Teddy Boucle", "Cream"), "boucle-cream")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accepts an exact combination approval without treating the swatch sample as a product reference", async () => {
    const noPhoto = [variant("boucle-cream", "Teddy Boucle", "Cream", "King", null)];
    const admin = api(noPhoto);
    admin.graphql.mockImplementation(async (query?: any) => Response.json({ data: { product: query?.includes("TryoraPreviewMedia")
      ? { media: { nodes: [{ id: "approved", image: { url: "https://cdn.shopify.com/approved-bed.jpg" } }], pageInfo: { hasNextPage: false } } }
      : { title: "Bed", productType: "Bed", options, variants: { nodes: noPhoto, pageInfo: { hasNextPage: false } } } } }));
    const approved = { ...config, choices: [{ optionValue: key("Teddy Boucle", "Cream"), available: true, variantIds: ["boucle-cream"], approvedMediaIds: ["approved"] }] };
    expect((await resolvePreviewProduct(admin, approved, key("Teddy Boucle", "Cream"), "boucle-cream")).urls)
      .toEqual(["https://cdn.shopify.com/approved-bed.jpg"]);
  });
});
