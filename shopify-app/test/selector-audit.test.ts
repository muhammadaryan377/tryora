import { describe, expect, it, vi } from "vitest";
import { nativeSelections } from "../app/core/customization";
import { eligibleVariants } from "../app/native-selection.server";
import { resolvePreviewProduct } from "../app/preview-product.server";
import { selectorAuditFixtures as fixtures } from "./fixtures/selector-audit";

const key = (fabric: string, colour: string) => JSON.stringify([fabric, colour]);
function setup(fixture: typeof fixtures[keyof typeof fixtures], visualOptionName = fixture.visualOptionName) {
  const config = { productId: "audit-bed", visualOptionName, referenceMediaId: "generic",
    frozenContext: {}, choices: [] } as any;
  const graphql = vi.fn(async () => Response.json({ data: { product: { title: "Audit bed", productType: "Beds",
    ...fixture, variants: { nodes: fixture.variants, pageInfo: { hasNextPage: false } } } } }));
  return { config, admin: { graphql }, model: nativeSelections(fixture.options, visualOptionName, fixture.variants) };
}

describe("selector discovery audit fixtures", () => {
  it.each([
    ["native", 2, "Fabric"], ["fabricOnly", 2, null], ["externalColours", 0, null],
    ["sizesAndFabrics", 2, null], ["missingPhoto", 1, "Fabric"], ["singleStyle", 0, null],
  ] as const)("characterizes %s without inventing additional choices", (name, count, dependent) => {
    const { model } = setup(fixtures[name]);
    expect(model.selections).toHaveLength(count);
    expect(model.fabricOptionName).toBe(dependent);
  });

  it("uses only the exact native fabric/colour reference, not another combination", async () => {
    const { admin, config } = setup(fixtures.native);
    expect((await resolvePreviewProduct(admin, config, key("Teddy Boucle", "Grey"), "boucle-grey")).urls)
      .toEqual(["https://cdn.shopify.com/boucle-grey.jpg"]);
    await expect(resolvePreviewProduct(admin, config, key("Teddy Boucle", "Cream"), "boucle-grey"))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not turn fabric-only values into colours", async () => {
    const { admin, config, model } = setup(fixtures.fabricOnly);
    expect(model.selectorLabel).toBe("Fabric");
    expect(model.selections.map((s) => s.label)).toEqual(["Plush Velvet", "Teddy Boucle"]);
    await expect(resolvePreviewProduct(admin, config, "Cream", "velvet")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not trust external labels or metafield blobs as native choices or approvals", async () => {
    const { admin, config, model } = setup(fixtures.externalColours);
    expect(model.selections).toEqual([]);
    await expect(resolvePreviewProduct(admin, config, "Cream", "king")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(resolvePreviewProduct(admin, config, "__single__")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("retains size restrictions and refuses to replace a missing combination photo", async () => {
    const { config, model } = setup(fixtures.sizesAndFabrics);
    const eligible = eligibleVariants({ ...config, frozenContext: { Size: "Double" } },
      fixtures.sizesAndFabrics.variants, model.selections.find((s) => s.value === "Teddy Boucle"));
    expect(eligible).toEqual([]);
    const missing = setup(fixtures.missingPhoto);
    await expect(resolvePreviewProduct(missing.admin, missing.config, key("Plush Velvet", "Cream"), "no-photo"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a genuine single-style preview working with its exact variant photo", async () => {
    const { admin, config } = setup(fixtures.singleStyle);
    config.referenceMediaId = null;
    expect((await resolvePreviewProduct(admin, config, "__single__", "single")).urls)
      .toEqual(["https://cdn.shopify.com/single.jpg"]);
  });

  it("reproduces empty selectors from saved null, stale names and unsupported native naming", () => {
    expect(setup(fixtures.native, null).model.selections).toEqual([]);
    expect(setup(fixtures.native, "Old Colour").model.selections).toEqual([]);
    const renamed = { ...fixtures.native, options: fixtures.native.options.map((o) =>
      o.name === "Colour" ? { ...o, name: "Upholstery Shade" } : o) };
    expect(setup(renamed).model.fabricOptionName).toBeNull();
  });
});
