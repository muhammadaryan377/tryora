import { describe, expect, it, vi } from "vitest";
vi.mock("../app/products.server", () => ({ defaultNoun: () => "chair" }));
import { resolvePreviewProduct } from "../app/preview-product.server";

const config = { productId: "gid://shopify/Product/1", visualOptionName: "Colour", referenceMediaId: "media", frozenContext: {}, choices: [] } as any;
const product = (variantValue: string, next = false) => ({ title: "Chair", productType: "chair", options: [{ name: "Colour", optionValues: [{ name: "Blue" }, { name: "Red" }] }], variants: { nodes: [{ id: "v", availableForSale: true, selectedOptions: [{ name: "Colour", value: variantValue }, { name: "Size", value: "Large" }], image: { url: "https://cdn.shopify.com/variant.jpg" } }], pageInfo: { hasNextPage: next, endCursor: next ? "next" : null } } });
const media = { data: { product: { media: { nodes: [{ id: "media", image: { url: "https://cdn.shopify.com/product.jpg" } }], pageInfo: { hasNextPage: false } } } } };

describe("product reference resolution", () => {
  it("paginates variants to find an available matching selection", async () => {
    const graphql = vi.fn().mockResolvedValueOnce(Response.json({ data: { product: product("Red", true) } }))
      .mockResolvedValueOnce(Response.json({ data: { product: product("Blue") } }))
      .mockResolvedValueOnce(Response.json(media));
    const result = await resolvePreviewProduct({ graphql }, config, "Blue");
    expect(result.urls[0]).toBe("https://cdn.shopify.com/variant.jpg");
    expect(graphql.mock.calls[1]![1].variables.after).toBe("next");
  });
  it("resolves the real option value for a single-colour product", async () => {
    const p = product("Blue"); p.options[0]!.optionValues = [{ name: "Blue" }];
    const graphql = vi.fn().mockResolvedValueOnce(Response.json({ data: { product: p } })).mockResolvedValueOnce(Response.json(media));
    expect((await resolvePreviewProduct({ graphql }, config, "__single__")).optionValue).toBe("Blue");
  });
  it("enforces merchant frozen options and availability overrides", async () => {
    const graphql = vi.fn().mockImplementation(async () => Response.json({ data: { product: product("Blue") } }));
    await expect(resolvePreviewProduct({ graphql }, { ...config, frozenContext: { Size: "Small" } }, "Blue")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolvePreviewProduct({ graphql }, { ...config, choices: [{ optionValue: "Blue", available: false }] }, "Blue")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("fails safely if approved product media was removed", async () => {
    const graphql = vi.fn().mockResolvedValueOnce(Response.json({ data: { product: product("Blue") } })).mockResolvedValueOnce(Response.json({ data: { product: { media: { nodes: [null], pageInfo: { hasNextPage: false } } } } }));
    const withApproved = { ...config, choices: [{ optionValue: "Blue", available: true, approvedMediaIds: ["missing"] }] };
    await expect(resolvePreviewProduct({ graphql }, withApproved, "Blue")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("selection-specific reference safety", () => {
  it("refuses a generic product photo when a colour has no variant or approved photo", async () => {
    const p = product("Blue");
    (p.variants.nodes[0] as any).image = null;
    const graphql = vi.fn().mockResolvedValueOnce(Response.json({ data: { product: p } })).mockResolvedValueOnce(Response.json(media));
    await expect(resolvePreviewProduct({ graphql }, config, "Blue")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("uses a merchant-approved choice image when the variant has no photo", async () => {
    const p = product("Blue");
    (p.variants.nodes[0] as any).image = null;
    const graphql = vi.fn().mockResolvedValueOnce(Response.json({ data: { product: p } })).mockResolvedValueOnce(Response.json(media));
    const result = await resolvePreviewProduct({ graphql }, { ...config, choices: [{ optionValue: "Blue", available: true, approvedMediaIds: ["media"] }] }, "Blue");
    expect(result.urls[0]).toBe("https://cdn.shopify.com/product.jpg");
  });
});

describe("Shopify variant colour and size binding", () => {
  const pair = {
    title: "Modern bed", description: "Upholstered bed", productType: "Bed",
    options: [{ name: "Colour", optionValues: [{ name: "Beige" }, { name: "Grey" }] }],
    variants: { nodes: [
      { id: "gid://shopify/ProductVariant/11", availableForSale: true, image: { url: "https://cdn.shopify.com/beige-queen.jpg" }, selectedOptions: [{ name: "Colour", value: "Beige" }, { name: "Size", value: "Queen" }] },
      { id: "gid://shopify/ProductVariant/12", availableForSale: true, image: { url: "https://cdn.shopify.com/grey-queen.jpg" }, selectedOptions: [{ name: "Colour", value: "Grey" }, { name: "Size", value: "Queen" }] },
      { id: "gid://shopify/ProductVariant/13", availableForSale: true, image: { url: "https://cdn.shopify.com/grey-king.jpg" }, selectedOptions: [{ name: "Colour", value: "Grey" }, { name: "Size", value: "King" }] },
    ], pageInfo: { hasNextPage: false, endCursor: null } },
  };

  it("uses the exact selected grey king bed photo without a beige generic reference", async () => {
    const graphql = vi.fn(async () => Response.json({ data: { product: pair } }));
    const selected = await resolvePreviewProduct({ graphql }, config, "Grey", "gid://shopify/ProductVariant/13");
    expect(selected.variantId).toBe("gid://shopify/ProductVariant/13");
    expect(selected.urls).toEqual(["https://cdn.shopify.com/grey-king.jpg"]);
    expect(selected.referenceVersion).toContain("gid://shopify/ProductVariant/13");
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("rejects an ID that belongs to another colour, frozen size, or unavailable variant", async () => {
    const graphql = vi.fn(async () => Response.json({ data: { product: pair } }));
    await expect(resolvePreviewProduct({ graphql }, config, "Grey", "gid://shopify/ProductVariant/11"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolvePreviewProduct({ graphql }, { ...config, frozenContext: { Size: "Queen" } }, "Grey", "gid://shopify/ProductVariant/13"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolvePreviewProduct({ graphql }, { ...config, choices: [{ optionValue: "Grey", available: true, variantIds: ["gid://shopify/ProductVariant/12"] }] }, "Grey", "gid://shopify/ProductVariant/13"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unavailable = { ...pair, variants: { ...pair.variants, nodes: pair.variants.nodes.map((v) =>
      v.id.endsWith("/13") ? { ...v, availableForSale: false } : v) } };
    const blocked = vi.fn(async () => Response.json({ data: { product: unavailable } }));
    await expect(resolvePreviewProduct({ graphql: blocked }, config, "Grey", "gid://shopify/ProductVariant/13"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires the selected variant's own reference or approved choice image", async () => {
    const lackingImage = { ...pair, variants: { ...pair.variants, nodes: pair.variants.nodes.map((v) =>
      v.id.endsWith("/13") ? { ...v, image: null } : v) } };
    const graphql = vi.fn(async () => Response.json({ data: { product: lackingImage } }));
    await expect(resolvePreviewProduct({ graphql }, config, "Grey", "gid://shopify/ProductVariant/13"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
